import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthTokens, Challenge, replacePasskeyMessage, type Vault } from '@cw/shared';
import { buildApp } from './app.ts';
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
const app = () =>
  buildApp({
    checkDb: async () => {},
    db,
    jwtSecret: JWT_SECRET,
    verifyGoogleIdToken: async (idToken) => (idToken.startsWith('google:') ? idToken.slice(7) : null),
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
  await sql`truncate users, refresh_tokens, vaults, challenges`.execute(db);
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

describe('PUT /vault/passkey (self-repair, signed with the vault key)', () => {
  // Stands in for the vault's signing key pair; the app derives it from the vault key (decision 033).
  const newSigningKey = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return { privateKey, publicKey: publicKey.export({ format: 'jwk' }).x as string };
  };
  const signBody = (privateKey: KeyObject, challenge: string, content: { wrappedVaultKey: string; passkeyCredentialId: string }) =>
    sign(null, Buffer.from(replacePasskeyMessage({ challenge, ...content })), privateKey).toString('base64url');

  const replacement = { wrappedVaultKey: 'C'.repeat(98), passkeyCredentialId: 'new-credential' };

  /** A signed-in user with a vault whose signing public key is `key.publicKey`. */
  async function userWithVault(sub: string, key = newSigningKey()) {
    const { accessToken } = await signIn(sub);
    await app().inject({
      method: 'PUT',
      url: '/vault',
      headers: bearer(accessToken),
      payload: { ...vault, signingPublicKey: key.publicKey },
    });
    return { accessToken, key };
  }
  const getChallenge = async (accessToken: string) =>
    Challenge.parse((await app().inject({ method: 'POST', url: '/vault/challenge', headers: bearer(accessToken) })).json());
  const replace = (accessToken: string, payload: object) =>
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
