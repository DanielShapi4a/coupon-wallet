import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import * as m0001 from '../migrations/0001_init.ts';
import * as m0002 from '../migrations/0002_auth_and_vault.ts';
import * as m0003 from '../migrations/0003_challenges.ts';
import * as m0004 from '../migrations/0004_items.ts';
import type { ItemMetadata } from '@cw/shared';

// Hand-written to match the migrations; switch to kysely-codegen once there are several more tables (ADR-002).
export interface Database {
  users: {
    id: Generated<string>;
    google_sub: string;
    created_at: ColumnType<Date, never, never>;
  };
  refresh_tokens: {
    id: Generated<string>;
    user_id: string;
    token_hash: string;
    expires_at: Date;
    revoked_at: Date | null;
    created_at: ColumnType<Date, never, never>;
  };
  vaults: {
    user_id: string;
    wrapped_vault_key: string;
    signing_public_key: string;
    passkey_credential_id: string;
    created_at: ColumnType<Date, never, never>;
    updated_at: ColumnType<Date, never, Date>;
  };
  items: {
    user_id: string;
    id: string;
    version: number;
    deleted: boolean;
    metadata: ColumnType<ItemMetadata, string, string>;
    credential: string | null;
    details: string | null;
    updated_at: ColumnType<Date, never, Date>;
  };
  challenges: {
    id: Generated<string>;
    user_id: string;
    purpose: string;
    challenge: string;
    expires_at: Date;
    used_at: Date | null;
    created_at: ColumnType<Date, never, never>;
  };
}

export function createDb(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  });
}

// Static list instead of reading a folder: works the same on Windows and in the Linux image.
const migrations = {
  '0001_init': m0001,
  '0002_auth_and_vault': m0002,
  '0003_challenges': m0003,
  '0004_items': m0004,
};

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const { error, results } = await new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  }).migrateToLatest();
  for (const r of results ?? []) console.log(`migration ${r.migrationName}: ${r.status}`);
  if (error) throw error;
}
