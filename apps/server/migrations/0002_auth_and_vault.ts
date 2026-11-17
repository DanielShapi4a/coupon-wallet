import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Only a hash of each refresh token is stored, so a database leak does not hand out sessions.
  await db.schema
    .createTable('refresh_tokens')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('refresh_tokens_user_id').on('refresh_tokens').column('user_id').execute();

  // One vault per user (decision 009, single writer). Nothing here can be decrypted by the server (ADR-001).
  await db.schema
    .createTable('vaults')
    .addColumn('user_id', 'uuid', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('wrapped_vault_key', 'text', (c) => c.notNull())
    .addColumn('signing_public_key', 'text', (c) => c.notNull())
    .addColumn('passkey_credential_id', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('vaults').execute();
  await db.schema.dropTable('refresh_tokens').execute();
}
