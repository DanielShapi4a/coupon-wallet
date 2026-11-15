import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import * as m0001 from '../migrations/0001_init.ts';

// Hand-written to match the migrations; switch to kysely-codegen once there are several tables (ADR-002).
export interface Database {
  users: {
    id: Generated<string>;
    google_sub: string;
    created_at: ColumnType<Date, never, never>;
  };
}

export function createDb(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  });
}

// Static list instead of reading a folder: works the same on Windows and in the Linux image.
const migrations = { '0001_init': m0001 };

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const { error, results } = await new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  }).migrateToLatest();
  for (const r of results ?? []) console.log(`migration ${r.migrationName}: ${r.status}`);
  if (error) throw error;
}
