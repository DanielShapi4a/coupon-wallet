import { describe, expect, it } from 'vitest';
import { HealthResponse } from '@cw/shared';
import { buildApp } from './app.ts';

describe('GET /health', () => {
  it('reports the database as up', async () => {
    const app = buildApp(async () => {});
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json())).toEqual({ ok: true, db: 'up' });
  });

  it('returns 503 when the database does not respond', async () => {
    const app = buildApp(async () => {
      throw new Error('connection refused');
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(HealthResponse.parse(res.json())).toEqual({ ok: false, db: 'down' });
  });
});
