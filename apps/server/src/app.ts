import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { sql, type Kysely } from 'kysely';
import {
  GoogleSignInRequest,
  RefreshRequest,
  ReplacePasskeyRequest,
  replacePasskeyMessage,
  Vault,
  type Challenge,
  type HealthResponse,
} from '@cw/shared';
import type { Database } from './db.ts';
import type { VerifyGoogleIdToken } from './google.ts';
import { verifyEd25519 } from './signatures.ts';
import { issueTokens, rotateRefreshToken, verifyAccessToken } from './tokens.ts';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const REPLACE_PASSKEY = 'replace_passkey';

export interface AppDeps {
  checkDb: () => Promise<void>;
  db: Kysely<Database>;
  jwtSecret: string;
  verifyGoogleIdToken: VerifyGoogleIdToken;
}

export function buildApp(deps: AppDeps, options: FastifyServerOptions = {}) {
  const { db, jwtSecret } = deps;
  const app = Fastify(options);

  const badRequest = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });
  const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: 'unauthorized' });

  /** The user ID from a valid `Authorization: Bearer` access token, or null after replying 401. */
  async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const header = req.headers.authorization;
    const userId = header?.startsWith('Bearer ') ? await verifyAccessToken(header.slice(7), jwtSecret) : null;
    if (!userId) unauthorized(reply);
    return userId;
  }

  app.get('/health', async (_req, reply): Promise<HealthResponse> => {
    try {
      await deps.checkDb();
      return { ok: true, db: 'up' };
    } catch (err) {
      app.log.error({ err }, 'health check: database unreachable');
      reply.code(503);
      return { ok: false, db: 'down' };
    }
  });

  // Sign in with a Google ID token. Only the Google account ID is kept, not the email (minimal data).
  app.post('/auth/google', async (req, reply) => {
    const body = GoogleSignInRequest.safeParse(req.body);
    if (!body.success) return badRequest(reply);
    const googleSub = await deps.verifyGoogleIdToken(body.data.idToken);
    if (!googleSub) return unauthorized(reply);

    const user = await db
      .insertInto('users')
      .values({ google_sub: googleSub })
      // A no-op update so that RETURNING also yields the ID of an existing user.
      .onConflict((oc) => oc.column('google_sub').doUpdateSet({ google_sub: googleSub }))
      .returning('id')
      .executeTakeFirstOrThrow();
    return issueTokens(db, user.id, jwtSecret);
  });

  app.post('/auth/refresh', async (req, reply) => {
    const body = RefreshRequest.safeParse(req.body);
    if (!body.success) return badRequest(reply);
    const tokens = await rotateRefreshToken(db, body.data.refreshToken, jwtSecret);
    return tokens ?? unauthorized(reply);
  });

  app.get('/vault', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const row = await db
      .selectFrom('vaults')
      .select(['wrapped_vault_key', 'signing_public_key', 'passkey_credential_id'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return {
      wrappedVaultKey: row.wrapped_vault_key,
      signingPublicKey: row.signing_public_key,
      passkeyCredentialId: row.passkey_credential_id,
    } satisfies Vault;
  });

  // Creates the vault once. Replacing it (self-repair) will require a signature with the vault's key (decision 033).
  app.put('/vault', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const body = Vault.safeParse(req.body);
    if (!body.success) return badRequest(reply);
    const inserted = await db
      .insertInto('vaults')
      .values({
        user_id: userId,
        wrapped_vault_key: body.data.wrappedVaultKey,
        signing_public_key: body.data.signingPublicKey,
        passkey_credential_id: body.data.passkeyCredentialId,
      })
      .onConflict((oc) => oc.column('user_id').doNothing())
      .returning('user_id')
      .executeTakeFirst();
    if (!inserted) return reply.code(409).send({ error: 'vault_exists' });
    return reply.code(201).send(body.data);
  });

  // A one-time challenge to replace the vault's passkey (self-repair, decision 035).
  app.post('/vault/challenge', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const challenge = randomBytes(32).toString('base64url');
    const row = await db
      .insertInto('challenges')
      .values({ user_id: userId, purpose: REPLACE_PASSKEY, challenge, expires_at: new Date(Date.now() + CHALLENGE_TTL_MS) })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { challengeId: row.id, challenge } satisfies Challenge;
  });

  // Replaces the wrapped vault key and the passkey ID. Needs a signature with the vault key over the
  // challenge and the new content (decision 033): an access token alone is not enough, so someone who
  // takes over the Google account cannot lock the user out of the vault.
  app.put('/vault/passkey', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const body = ReplacePasskeyRequest.safeParse(req.body);
    if (!body.success) return badRequest(reply);

    const vault = await db
      .selectFrom('vaults')
      .select('signing_public_key')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!vault) return reply.code(404).send({ error: 'not_found' });

    // Consume the challenge atomically: it works once, for this user and purpose, before it expires.
    // A wrong signature still uses it up; the app asks for a new one.
    const challenge = await db
      .updateTable('challenges')
      .set({ used_at: new Date() })
      .where('id', '=', body.data.challengeId)
      .where('user_id', '=', userId)
      .where('purpose', '=', REPLACE_PASSKEY)
      .where('used_at', 'is', null)
      .where('expires_at', '>', new Date())
      .returning('challenge')
      .executeTakeFirst();
    if (!challenge) return reply.code(401).send({ error: 'invalid_challenge' });

    const message = replacePasskeyMessage({ challenge: challenge.challenge, ...body.data });
    if (!verifyEd25519(vault.signing_public_key, message, body.data.signature)) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    await db
      .updateTable('vaults')
      .set({
        wrapped_vault_key: body.data.wrappedVaultKey,
        passkey_credential_id: body.data.passkeyCredentialId,
        updated_at: sql<Date>`now()`,
      })
      .where('user_id', '=', userId)
      .execute();
    return {
      wrappedVaultKey: body.data.wrappedVaultKey,
      signingPublicKey: vault.signing_public_key,
      passkeyCredentialId: body.data.passkeyCredentialId,
    } satisfies Vault;
  });

  return app;
}
