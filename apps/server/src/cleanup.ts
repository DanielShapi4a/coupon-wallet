import type { Kysely } from 'kysely';
import type { Database } from './db.ts';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Daily housekeeping (run by the worker): drops rows that can no longer be used, so the
 * database keeps only what it needs (data minimization).
 * - Expired refresh tokens. Revoked ones stay until they expire, so reuse of a stolen,
 *   already-rotated token is still detected as theft.
 * - Challenges, an hour after they expired: each works once and for 5 minutes only.
 */
export async function cleanup(db: Kysely<Database>, now = new Date()): Promise<{ refreshTokens: number; challenges: number }> {
  const tokens = await db.deleteFrom('refresh_tokens').where('expires_at', '<', now).executeTakeFirst();
  const challenges = await db
    .deleteFrom('challenges')
    .where('expires_at', '<', new Date(now.getTime() - HOUR_MS))
    .executeTakeFirst();
  return { refreshTokens: Number(tokens.numDeletedRows), challenges: Number(challenges.numDeletedRows) };
}
