import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { HealthResponse } from '@cw/shared';
import { buildApp, type AppDeps } from './app.ts';
import type { Database } from './db.ts';

// /health needs no database: these deps are never touched.
const deps = (checkDb: AppDeps['checkDb']): AppDeps => ({
  checkDb,
  db: {} as Kysely<Database>,
  jwtSecret: 'x'.repeat(32),
  verifyGoogleIdToken: async () => null,
});

describe('GET /health', () => {
  it('reports the database as up', async () => {
    const app = buildApp(deps(async () => {}));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json())).toEqual({ ok: true, db: 'up' });
  });

  it('returns 503 when the database does not respond', async () => {
    const app = buildApp(
      deps(async () => {
        throw new Error('connection refused');
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(HealthResponse.parse(res.json())).toEqual({ ok: false, db: 'down' });
  });
});
