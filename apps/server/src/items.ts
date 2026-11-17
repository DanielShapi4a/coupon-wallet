import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { SealedItem } from '@cw/shared';
import type { Database } from './db.ts';

const ItemParams = z.object({ id: z.uuid() });

/**
 * Item sync (architecture.md: single writer, a version per item). Every query is scoped to the
 * user from the access token, never to an ID the client sends alone.
 */
export function registerItemRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<string | null>,
  maxItemsPerUser: number,
): void {
  // Saves a newer version of an item. The same version again changes nothing (the outbox may resend);
  // an older one is refused, so a late retry never overwrites a newer change.
  app.put('/items/:id', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const params = ItemParams.safeParse(req.params);
    const body = SealedItem.safeParse(req.body);
    if (!params.success || !body.success || body.data.id !== params.data.id) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const item = body.data;

    const existing = await db
      .selectFrom('items')
      .select('version')
      .where('user_id', '=', userId)
      .where('id', '=', item.id)
      .executeTakeFirst();
    if (!existing) {
      // A cap per user, so one account cannot fill the database.
      const { count } = await db
        .selectFrom('items')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      if (Number(count) >= maxItemsPerUser) return reply.code(403).send({ error: 'item_limit' });
    } else if (existing.version === item.version) {
      return { version: item.version };
    } else if (existing.version > item.version) {
      return reply.code(409).send({ error: 'stale', currentVersion: existing.version });
    }

    // Nothing secret is kept for a deleted item.
    const values = {
      version: item.version,
      deleted: item.deleted,
      metadata: JSON.stringify(item.metadata),
      credential: item.deleted ? null : item.credential,
      details: item.deleted ? null : item.details,
    };
    const saved = await db
      .insertInto('items')
      .values({ user_id: userId, id: item.id, ...values })
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'id'])
          .doUpdateSet({ ...values, updated_at: sql<Date>`now()` })
          // Re-checked here: a concurrent request with a newer version wins.
          .where((eb) => eb('items.version', '<', item.version)),
      )
      .returning('version')
      .executeTakeFirst();
    if (!saved) return reply.code(409).send({ error: 'stale' });
    return { version: saved.version };
  });

  // Every live item of the user, for recovery on a new phone.
  // ponytail: no paging; each user is capped at maxItemsPerUser items.
  app.get('/items', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const rows = await db
      .selectFrom('items')
      .select(['id', 'version', 'metadata', 'credential', 'details'])
      .where('user_id', '=', userId)
      .where('deleted', '=', false)
      .orderBy('updated_at')
      .execute();
    return rows.map(
      (r): SealedItem => ({
        id: r.id,
        version: r.version,
        deleted: false,
        metadata: r.metadata,
        credential: r.credential ?? '',
        details: r.details ?? '',
      }),
    );
  });
}
