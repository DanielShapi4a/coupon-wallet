import { SignJWT } from 'jose';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthTokens, type Vault } from '@cw/shared';
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
  await sql`truncate users, refresh_tokens, vaults`.execute(db);
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
