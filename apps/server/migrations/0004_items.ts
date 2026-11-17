import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Item IDs come from the phone. The key includes the user, so one user's ID can never reach
  // another user's item, even if it is guessed or copied.
  await db.schema
    .createTable('items')
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('id', 'uuid', (c) => c.notNull())
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('deleted', 'boolean', (c) => c.notNull().defaultTo(false))
    // Readable by the server (decision 006): reminders and aggregate statistics.
    .addColumn('metadata', 'jsonb', (c) => c.notNull())
    // Sealed on the phone; null once the item is deleted (nothing secret is kept for a deleted item).
    .addColumn('credential', 'text')
    .addColumn('details', 'text')
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('items_pkey', ['user_id', 'id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('items').execute();
}
