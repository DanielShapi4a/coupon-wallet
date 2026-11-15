import Fastify, { type FastifyServerOptions } from 'fastify';
import type { HealthResponse } from '@cw/shared';

export function buildApp(checkDb: () => Promise<void>, options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  app.get('/health', async (_req, reply): Promise<HealthResponse> => {
    try {
      await checkDb();
      return { ok: true, db: 'up' };
    } catch (err) {
      app.log.error({ err }, 'health check: database unreachable');
      reply.code(503);
      return { ok: false, db: 'down' };
    }
  });

  return app;
}
