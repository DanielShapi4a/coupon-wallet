import Fastify, { type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { GoogleSignInRequest, RefreshRequest, Vault, type HealthResponse } from '@cw/shared';
import type { Database } from './db.ts';
import type { VerifyGoogleIdToken } from './google.ts';
import { issueTokens, rotateRefreshToken, verifyAccessToken } from './tokens.ts';

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

  return app;
}
