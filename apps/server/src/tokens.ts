import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { Kysely } from 'kysely';
import type { AuthTokens } from '@cw/shared';
import type { Database } from './db.ts';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 60;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const secretKey = (secret: string) => new TextEncoder().encode(secret);

/** A new session: a short-lived access token, and a refresh token stored only as a hash. */
export async function issueTokens(db: Kysely<Database>, userId: string, jwtSecret: string): Promise<AuthTokens> {
  const accessToken = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(secretKey(jwtSecret));

  const refreshToken = randomBytes(32).toString('base64url');
  await db
    .insertInto('refresh_tokens')
    .values({
      user_id: userId,
      token_hash: hash(refreshToken),
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
    })
    .execute();

  return { accessToken, refreshToken };
}

/** Returns the user ID of a valid access token, or null. */
export async function verifyAccessToken(token: string, jwtSecret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(jwtSecret), { algorithms: ['HS256'] });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Exchanges a refresh token for a new pair; the old one stops working. A token that was already
 * used is a sign of theft, so every session of that user is revoked.
 * ponytail: two refreshes racing with the same token also look like reuse and sign the user out;
 * add a short grace period if that shows up in practice.
 */
export async function rotateRefreshToken(
  db: Kysely<Database>,
  presented: string,
  jwtSecret: string,
): Promise<AuthTokens | null> {
  const row = await db
    .selectFrom('refresh_tokens')
    .select(['id', 'user_id', 'expires_at', 'revoked_at'])
    .where('token_hash', '=', hash(presented))
    .executeTakeFirst();
  if (!row) return null;

  if (row.revoked_at) {
    await revokeAllSessions(db, row.user_id);
    return null;
  }

  // Revoke only if still active: of two concurrent requests, exactly one wins.
  const revoked = await db
    .updateTable('refresh_tokens')
    .set({ revoked_at: new Date() })
    .where('id', '=', row.id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (revoked.numUpdatedRows === 0n) {
    await revokeAllSessions(db, row.user_id);
    return null;
  }
  if (row.expires_at < new Date()) return null;

  return issueTokens(db, row.user_id, jwtSecret);
}

export async function revokeAllSessions(db: Kysely<Database>, userId: string): Promise<void> {
  await db
    .updateTable('refresh_tokens')
    .set({ revoked_at: new Date() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}
