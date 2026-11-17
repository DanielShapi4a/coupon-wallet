import { sql, type Kysely } from 'kysely';

// One-time challenges for actions that need proof of holding the vault key (decision 033):
// replacing the passkey now; switching the active device and deleting the account later.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('challenges')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('purpose', 'text', (c) => c.notNull())
    .addColumn('challenge', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('used_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('challenges').execute();
}
