import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthTokens, Challenge, deleteAccountMessage, replacePasskeyMessage, type ChallengePurpose, type Vault } from '@cw/shared';
import { buildApp } from './app.ts';
import { cleanup } from './cleanup.ts';
import { createDb, migrateToLatest, type Database } from './db.ts';

// Runs against a real PostgreSQL: the local Docker Compose one, or the CI service.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://cw:cw@127.0.0.1:5432/cw_test';
const JWT_SECRET = 'test-secret-'.padEnd(40, 'x');

/** Creates the test database on the local server if it does not exist yet. */
async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (exists.rowCount === 0) await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }
}

let db: Kysely<Database>;
// The fake Google verifier accepts tokens of the form "google:<sub>".
const app = (maxItemsPerUser?: number) =>
  buildApp({
    checkDb: async () => {},
    db,
    jwtSecret: JWT_SECRET,
    verifyGoogleIdToken: async (idToken) => (idToken.startsWith('google:') ? idToken.slice(7) : null),
    maxItemsPerUser,
  });

const signIn = async (sub: string) => {
  const res = await app().inject({ method: 'POST', url: '/auth/google', payload: { idToken: `google:${sub}` } });
  expect(res.statusCode).toBe(200);
  return AuthTokens.parse(res.json());
};
const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

const vault: Vault = {
  wrappedVaultKey: 'A'.repeat(98),
  signingPublicKey: 'B'.repeat(43),
  passkeyCredentialId: 'credential-id_123',
};

beforeAll(async () => {
  await ensureDatabase(TEST_DATABASE_URL);
  db = createDb(TEST_DATABASE_URL);
  await migrateToLatest(db);
});
beforeEach(async () => {
  await sql`truncate users, refresh_tokens, vaults, challenges, items`.execute(db);
});
afterAll(async () => {
  await db?.destroy();
});

describe('POST /auth/google', () => {
  it('signs in with a valid Google ID token, and finds the same user next time', async () => {
    const first = await signIn('sub-1');
    await app().inject({ method: 'PUT', url: '/vault', headers: bearer(first.accessToken), payload: vault });
    const second = await signIn('sub-1');
    const res = await app().inject({ method: 'GET', url: '/vault', headers: bearer(second.accessToken) });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an invalid Google ID token and a malformed body', async () => {
    expect((await app().inject({ method: 'POST', url: '/auth/google', payload: { idToken: 'forged' } })).statusCode).toBe(401);
    expect((await app().inject({ method: 'POST', url: '/auth/google', payload: {} })).statusCode).toBe(400);
  });

  it('stores only a hash of the refresh token', async () => {
    const { refreshToken } = await signIn('sub-1');
    const rows = await db.selectFrom('refresh_tokens').select('token_hash').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toContain(refreshToken);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the refresh token: the new one works, the old one does not', async () => {
    const first = await signIn('sub-1');
    const res = await app().inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: first.refreshToken } });
    expect(res.statusCode).toBe(200);
    const second = AuthTokens.parse(res.json());
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const vaultRes = await app().inject({ method: 'GET', url: '/vault', headers: bearer(second.accessToken) });
    expect(vaultRes.statusCode).toBe(404);
  });

  it('treats reuse of an old refresh token as theft and revokes every session', async () => {
    const first = await signIn('sub-1');
    const rotated = AuthTokens.parse(
      (await app().inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: first.refreshToken } })).json(),
    );
    const reuse = await app().inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: first.refreshToken } });
    expect(reuse.statusCode).toBe(401);
    const afterTheft = await app().inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: rotated.refreshToken } });
    expect(afterTheft.statusCode).toBe(401);
  });

  it('rejects an unknown refresh token', async () => {
    const res = await app().inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: 'unknown' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('/vault', () => {
  it('needs a valid, unexpired access token', async () => {
    expect((await app().inject({ method: 'GET', url: '/vault' })).statusCode).toBe(401);
    expect((await app().inject({ method: 'GET', url: '/vault', headers: bearer('garbage') })).statusCode).toBe(401);

    const { accessToken } = await signIn('sub-1');
    const userId = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString()).sub as string;
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(JWT_SECRET));
    expect((await app().inject({ method: 'GET', url: '/vault', headers: bearer(expired) })).statusCode).toBe(401);
  });

  it('stores the vault once and returns it', async () => {
    const { accessToken } = await signIn('sub-1');
    expect((await app().inject({ method: 'GET', url: '/vault', headers: bearer(accessToken) })).statusCode).toBe(404);

    const put = await app().inject({ method: 'PUT', url: '/vault', headers: bearer(accessToken), payload: vault });
    expect(put.statusCode).toBe(201);
    const get = await app().inject({ method: 'GET', url: '/vault', headers: bearer(accessToken) });
    expect(get.json()).toEqual(vault);

    const again = await app().inject({ method: 'PUT', url: '/vault', headers: bearer(accessToken), payload: vault });
    expect(again.statusCode).toBe(409);
  });

  it('rejects a malformed vault', async () => {
    const { accessToken } = await signIn('sub-1');
    const bad = { ...vault, signingPublicKey: 'too-short' };
    expect((await app().inject({ method: 'PUT', url: '/vault', headers: bearer(accessToken), payload: bad })).statusCode).toBe(400);
  });

  it('keeps users apart', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    await app().inject({ method: 'PUT', url: '/vault', headers: bearer(alice.accessToken), payload: vault });
    expect((await app().inject({ method: 'GET', url: '/vault', headers: bearer(bob.accessToken) })).statusCode).toBe(404);
  });
});

// Stands in for the vault's signing key pair; the app derives it from the vault key (decision 033).
const newSigningKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ format: 'jwk' }).x as string };
};

/** A signed-in user with a vault whose signing public key is `key.publicKey`. */
async function userWithVault(sub: string, key = newSigningKey()) {
  const { accessToken, refreshToken } = await signIn(sub);
  await app().inject({
    method: 'PUT',
    url: '/vault',
    headers: bearer(accessToken),
    payload: { ...vault, signingPublicKey: key.publicKey },
  });
  return { accessToken, refreshToken, key };
}

const getChallenge = async (accessToken: string, purpose: ChallengePurpose = 'replace_passkey') =>
  Challenge.parse(
    (await app().inject({ method: 'POST', url: '/vault/challenge', headers: bearer(accessToken), payload: { purpose } })).json(),
  );

describe('POST /vault/challenge', () => {
  it('needs a known purpose', async () => {
    const { accessToken } = await signIn('sub-1');
    const post = (payload: object) => app().inject({ method: 'POST', url: '/vault/challenge', headers: bearer(accessToken), payload });
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ purpose: 'anything' })).statusCode).toBe(400);
    expect((await post({ purpose: 'delete_account' })).statusCode).toBe(200);
  });
});

describe('PUT /vault/passkey (self-repair, signed with the vault key)', () => {
  const signBody = (privateKey: KeyObject, challenge: string, content: { wrappedVaultKey: string; passkeyCredentialId: string }) =>
    sign(null, Buffer.from(replacePasskeyMessage({ challenge, ...content })), privateKey).toString('base64url');

  const replacement = { wrappedVaultKey: 'C'.repeat(98), passkeyCredentialId: 'new-credential' };

  const replace =(accessToken: string, payload: object) =>
    app().inject({ method: 'PUT', url: '/vault/passkey', headers: bearer(accessToken), payload });

  it('replaces the wrapped key and the passkey ID with a valid signature', async () => {
    const { accessToken, key } = await userWithVault('sub-1');
    const { challengeId, challenge } = await getChallenge(accessToken);
    const res = await replace(accessToken, { challengeId, ...replacement, signature: signBody(key.privateKey, challenge, replacement) });
    expect(res.statusCode).toBe(200);

    const stored = (await app().inject({ method: 'GET', url: '/vault', headers: bearer(accessToken) })).json();
    expect(stored).toEqual({ ...replacement, signingPublicKey: key.publicKey });
  });

  it('rejects a signature made with another key', async () => {
    const { accessToken } = await userWithVault('sub-1');
    const { challengeId, challenge } = await getChallenge(accessToken);
    const res = await replace(accessToken, { challengeId, ...replacement, signature: signBody(newSigningKey().privateKey, challenge, replacement) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_signature' });
  });

  it('rejects content changed after signing', async () => {
    const { accessToken, key } = await userWithVault('sub-1');
    const { challengeId, challenge } = await getChallenge(accessToken);
    const signature = signBody(key.privateKey, challenge, replacement);
    const res = await replace(accessToken, { challengeId, ...replacement, wrappedVaultKey: 'D'.repeat(98), signature });
    expect(res.statusCode).toBe(401);
  });

  it('accepts each challenge only once', async () => {
    const { accessToken, key } = await userWithVault('sub-1');
    const { challengeId, challenge } = await getChallenge(accessToken);
    const payload = { challengeId, ...replacement, signature: signBody(key.privateKey, challenge, replacement) };
    expect((await replace(accessToken, payload)).statusCode).toBe(200);
    const again = await replace(accessToken, payload);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: 'invalid_challenge' });
  });

  it('rejects an expired challenge', async () => {
    const { accessToken, key } = await userWithVault('sub-1');
    const { challengeId, challenge } = await getChallenge(accessToken);
    await db.updateTable('challenges').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', challengeId).execute();
    const res = await replace(accessToken, { challengeId, ...replacement, signature: signBody(key.privateKey, challenge, replacement) });
    expect(res.statusCode).toBe(401);
  });

  it("rejects another user's challenge", async () => {
    const alice = await userWithVault('alice');
    const bob = await userWithVault('bob');
    const { challengeId, challenge } = await getChallenge(alice.accessToken);
    const res = await replace(bob.accessToken, { challengeId, ...replacement, signature: signBody(bob.key.privateKey, challenge, replacement) });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 without a vault, and 400 for a malformed body', async () => {
    const { accessToken } = await signIn('no-vault');
    const { challengeId } = await getChallenge(accessToken);
    expect((await replace(accessToken, { challengeId, ...replacement, signature: 'A'.repeat(86) })).statusCode).toBe(404);
    expect((await replace(accessToken, { challengeId, ...replacement, signature: 'short' })).statusCode).toBe(400);
  });
});

describe('POST /auth/logout', () => {
  it('ends the session on the server: the refresh token stops working', async () => {
    const { refreshToken } = await signIn('sub-1');
    const res = await app().inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken } });
    expect(res.statusCode).toBe(204);
    const after = await app().inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(after.statusCode).toBe(401);
  });

  it('answers 204 for an unknown token too, revealing nothing', async () => {
    const res = await app().inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken: 'unknown' } });
    expect(res.statusCode).toBe(204);
  });
});

describe('cleanup (worker)', () => {
  it('removes expired refresh tokens and old challenges, and keeps live ones', async () => {
    const live = await signIn('sub-1');
    await signIn('sub-2');
    await db.updateTable('refresh_tokens').set({ expires_at: new Date(Date.now() - 1000) })
      .where('user_id', 'in', db.selectFrom('users').select('id').where('google_sub', '=', 'sub-2'))
      .execute();
    await getChallenge(live.accessToken);
    await getChallenge(live.accessToken, 'delete_account');
    const [old] = await db.selectFrom('challenges').select('id').execute();
    await db.updateTable('challenges').set({ expires_at: new Date(Date.now() - 2 * 60 * 60 * 1000) }).where('id', '=', old!.id).execute();

    expect(await cleanup(db)).toEqual({ refreshTokens: 1, challenges: 1 });
    expect((await app().inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: live.refreshToken } })).statusCode).toBe(200);
  });
});

const ID = '0b7c8a52-3f7e-4c1a-9d2b-5e6f7a8b9c0d';
// The server never sees plaintext secrets: these stand in for sealed ciphertext.
const sealed = (over: Record<string, unknown> = {}) => ({
  id: ID,
  version: 1,
  deleted: false,
  metadata: {
    merchant: 'Swish',
    value: { kind: 'stored_value', initialAgorot: 10_000, remainingAgorot: 10_000, lastVerifiedAt: null },
    status: 'active',
    usage: 'multi',
    channel: 'store',
    transferable: 'unknown',
    receivedFrom: null,
    receivedAt: null,
    validFrom: null,
    validUntil: '2026-12-31T23:59:59+02:00',
  },
  credential: 'Q1JFREVOVElBTA',
  details: 'REVUQUlMUw',
  ...over,
});

describe('DELETE /account (AUTH-6, signed with the vault key)', () => {
  const signDeletion = (privateKey: KeyObject, challenge: string) =>
    sign(null, Buffer.from(deleteAccountMessage(challenge)), privateKey).toString('base64url');
  const deleteAccount = (accessToken: string, payload: object) =>
    app().inject({ method: 'DELETE', url: '/account', headers: bearer(accessToken), payload });

  /** A user with a vault and one item. */
  async function userWithItem(sub: string) {
    const user = await userWithVault(sub);
    const put = await app().inject({ method: 'PUT', url: `/items/${ID}`, headers: bearer(user.accessToken), payload: sealed() });
    expect(put.statusCode).toBe(200);
    return user;
  }
  const rowsOf = async (userId: string) => ({
    users: (await db.selectFrom('users').select('id').where('id', '=', userId).execute()).length,
    vaults: (await db.selectFrom('vaults').select('user_id').where('user_id', '=', userId).execute()).length,
    items: (await db.selectFrom('items').select('id').where('user_id', '=', userId).execute()).length,
    sessions: (await db.selectFrom('refresh_tokens').select('user_id').where('user_id', '=', userId).execute()).length,
    challenges: (await db.selectFrom('challenges').select('id').where('user_id', '=', userId).execute()).length,
  });
  const userIdOf = (accessToken: string) => JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString()).sub as string;

  it('deletes everything of the user with a valid signature, and the tokens stop working at once', async () => {
    const { accessToken, refreshToken, key } = await userWithItem('sub-1');
    const { challengeId, challenge } = await getChallenge(accessToken, 'delete_account');
    const res = await deleteAccount(accessToken, { challengeId, signature: signDeletion(key.privateKey, challenge) });
    expect(res.statusCode).toBe(204);

    expect(await rowsOf(userIdOf(accessToken))).toEqual({ users: 0, vaults: 0, items: 0, sessions: 0, challenges: 0 });
    // The access token is still unexpired, but the user is gone (decision 043).
    expect((await app().inject({ method: 'GET', url: '/items', headers: bearer(accessToken) })).statusCode).toBe(401);
    expect((await app().inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } })).statusCode).toBe(401);
  });

  it("leaves other users' accounts and items untouched", async () => {
    const alice = await userWithItem('alice');
    const bob = await userWithItem('bob');
    const { challengeId, challenge } = await getChallenge(alice.accessToken, 'delete_account');
    expect((await deleteAccount(alice.accessToken, { challengeId, signature: signDeletion(alice.key.privateKey, challenge) })).statusCode).toBe(204);

    expect(await rowsOf(userIdOf(bob.accessToken))).toMatchObject({ users: 1, vaults: 1, items: 1 });
    expect((await app().inject({ method: 'GET', url: '/items', headers: bearer(bob.accessToken) })).statusCode).toBe(200);
  });

  it('signing in again after deletion starts a new, empty account', async () => {
    const { accessToken, key } = await userWithItem('sub-1');
    const { challengeId, challenge } = await getChallenge(accessToken, 'delete_account');
    await deleteAccount(accessToken, { challengeId, signature: signDeletion(key.privateKey, challenge) });

    const again = await signIn('sub-1');
    expect(userIdOf(again.accessToken)).not.toBe(userIdOf(accessToken));
    expect((await app().inject({ method: 'GET', url: '/vault', headers: bearer(again.accessToken) })).statusCode).toBe(404);
  });

  it('rejects a signature made with another key, and keeps the account', async () => {
    const alice = await userWithItem('alice');
    const { challengeId, challenge } = await getChallenge(alice.accessToken, 'delete_account');
    const res = await deleteAccount(alice.accessToken, { challengeId, signature: signDeletion(newSigningKey().privateKey, challenge) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_signature' });
    expect(await rowsOf(userIdOf(alice.accessToken))).toMatchObject({ users: 1, vaults: 1, items: 1 });
  });

  it("rejects another user's challenge, even signed with that user's key", async () => {
    const alice = await userWithItem('alice');
    const bob = await userWithItem('bob');
    const { challengeId, challenge } = await getChallenge(bob.accessToken, 'delete_account');
    const res = await deleteAccount(alice.accessToken, { challengeId, signature: signDeletion(bob.key.privateKey, challenge) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_challenge' });
    expect(await rowsOf(userIdOf(alice.accessToken))).toMatchObject({ users: 1 });
    expect(await rowsOf(userIdOf(bob.accessToken))).toMatchObject({ users: 1 });
  });

  it('rejects a challenge issued for replacing the passkey', async () => {
    const { accessToken, key } = await userWithItem('sub-1');
    const { challengeId, challenge } = await getChallenge(accessToken, 'replace_passkey');
    const res = await deleteAccount(accessToken, { challengeId, signature: signDeletion(key.privateKey, challenge) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_challenge' });
  });

  it('rejects a signature over another action’s message', async () => {
    const { accessToken, key } = await userWithItem('sub-1');
    const { challengeId, challenge } = await getChallenge(accessToken, 'delete_account');
    const content = { wrappedVaultKey: 'C'.repeat(98), passkeyCredentialId: 'x' };
    const signature = sign(null, Buffer.from(replacePasskeyMessage({ challenge, ...content })), key.privateKey).toString('base64url');
    expect((await deleteAccount(accessToken, { challengeId, signature })).statusCode).toBe(401);
  });

  it('uses a challenge up after one try', async () => {
    const { accessToken, key } = await userWithItem('sub-1');
    const { challengeId, challenge } = await getChallenge(accessToken, 'delete_account');
    await deleteAccount(accessToken, { challengeId, signature: signDeletion(newSigningKey().privateKey, challenge) });
    const res = await deleteAccount(accessToken, { challengeId, signature: signDeletion(key.privateKey, challenge) });
    expect(res.json()).toEqual({ error: 'invalid_challenge' });
  });

  it('needs the signature when there is a vault', async () => {
    const { accessToken } = await userWithItem('sub-1');
    expect((await deleteAccount(accessToken, {})).statusCode).toBe(400);
    expect(await rowsOf(userIdOf(accessToken))).toMatchObject({ users: 1 });
  });

  it('deletes an account without a vault with the access token alone', async () => {
    const { accessToken } = await signIn('no-vault');
    expect((await deleteAccount(accessToken, {})).statusCode).toBe(204);
    expect(await rowsOf(userIdOf(accessToken))).toMatchObject({ users: 0, sessions: 0 });
  });

  it('needs a valid access token', async () => {
    expect((await deleteAccount('not-a-token', {})).statusCode).toBe(401);
  });
});

describe('/items', () => {
  const put =(accessToken: string, body: Record<string, unknown>, id = body.id as string, maxItems?: number) =>
    app(maxItems).inject({ method: 'PUT', url: `/items/${id}`, headers: bearer(accessToken), payload: body });
  const list = async (accessToken: string) =>
    (await app().inject({ method: 'GET', url: '/items', headers: bearer(accessToken) })).json() as { id: string; version: number }[];

  it('creates an item and returns it', async () => {
    const { accessToken } = await signIn('sub-1');
    expect((await put(accessToken, sealed())).json()).toEqual({ version: 1 });
    expect(await list(accessToken)).toEqual([sealed()]);
  });

  it('keeps only newer versions: same version is a no-op, an older one is refused', async () => {
    const { accessToken } = await signIn('sub-1');
    await put(accessToken, sealed());
    const v2 = sealed({ version: 2, credential: 'TkVX' });
    expect((await put(accessToken, v2)).statusCode).toBe(200);
    expect((await put(accessToken, v2)).json()).toEqual({ version: 2 });
    const old = await put(accessToken, sealed({ version: 1, credential: 'T0xE' }));
    expect(old.statusCode).toBe(409);
    expect(old.json()).toEqual({ error: 'stale', currentVersion: 2 });
    expect((await list(accessToken))[0]).toMatchObject({ version: 2, credential: 'TkVX' });
  });

  it('deletes with a newer version, and keeps nothing secret for the deleted item', async () => {
    const { accessToken } = await signIn('sub-1');
    await put(accessToken, sealed());
    expect((await put(accessToken, sealed({ version: 2, deleted: true }))).statusCode).toBe(200);
    expect(await list(accessToken)).toEqual([]);
    const row = await db.selectFrom('items').select(['credential', 'details']).executeTakeFirstOrThrow();
    expect(row).toEqual({ credential: null, details: null });
  });

  it('rejects malformed requests', async () => {
    const { accessToken } = await signIn('sub-1');
    expect((await put(accessToken, sealed(), 'not-a-uuid')).statusCode).toBe(400);
    expect((await put(accessToken, sealed(), '1c8d9b63-4a8f-4d2b-8e3c-6f7a8b9c0d1e')).statusCode).toBe(400);
    expect((await put(accessToken, sealed({ metadata: { merchant: 'x' } }))).statusCode).toBe(400);
    expect((await put(accessToken, sealed({ credential: 'not base64url!' }))).statusCode).toBe(400);
  });

  it('needs a valid access token', async () => {
    expect((await app().inject({ method: 'GET', url: '/items' })).statusCode).toBe(401);
    expect((await app().inject({ method: 'PUT', url: `/items/${ID}`, payload: sealed() })).statusCode).toBe(401);
  });

  it('keeps users apart: no reading, overwriting or deleting another user\'s item, even with its ID', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    await put(alice.accessToken, sealed());

    expect(await list(bob.accessToken)).toEqual([]);
    // Same ID from Bob: it creates Bob's own item and leaves Alice's untouched.
    await put(bob.accessToken, sealed({ version: 5, credential: 'Qk9C' }));
    await put(bob.accessToken, sealed({ version: 6, deleted: true }));
    expect(await list(alice.accessToken)).toEqual([sealed()]);
  });

  it('caps the number of items per user', async () => {
    const { accessToken } = await signIn('sub-1');
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    expect((await put(accessToken, sealed({ id: ids[0] }), ids[0], 2)).statusCode).toBe(200);
    expect((await put(accessToken, sealed({ id: ids[1] }), ids[1], 2)).statusCode).toBe(200);
    const third = await put(accessToken, sealed({ id: ids[2] }), ids[2], 2);
    expect(third.statusCode).toBe(403);
    // Updating an existing item still works at the cap.
    expect((await put(accessToken, sealed({ id: ids[0], version: 2 }), ids[0], 2)).statusCode).toBe(200);
  });
});
