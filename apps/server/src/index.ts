import { sql } from 'kysely';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb, migrateToLatest } from './db.ts';

// One image, two roles (architecture.md): `api` serves HTTP, `worker` runs the daily sweep and exits.
const role = process.argv[2];
const config = loadConfig();
const db = createDb(config.DATABASE_URL);

if (role === 'api') {
  // ponytail: migrate on startup is fine for a single API instance; move it to a one-off task before running several.
  await migrateToLatest(db);
  const app = buildApp(async () => void (await sql`select 1`.execute(db)), {
    logger: { redact: ['req.headers.authorization'] },
  });
  const shutdown = async () => {
    await app.close();
    await db.destroy();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await app.listen({ port: config.PORT, host: config.HOST });
} else if (role === 'worker') {
  console.log('worker: nothing to do yet, the daily sweep comes later');
  await db.destroy();
} else {
  console.error('usage: node src/index.ts api|worker');
  process.exit(2);
}
