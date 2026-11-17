import { z } from 'zod';

// ADR-003: all configuration comes from environment variables, so the same image runs anywhere.
const Env = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // The Web OAuth client ID: the audience of the Google ID tokens the app sends. Not a secret.
  GOOGLE_WEB_CLIENT_ID: z.string().endsWith('.apps.googleusercontent.com'),
  // Signs our access tokens (HS256). At least 32 characters; in the cloud it comes from SSM (ADR-003).
  JWT_SECRET: z.string().min(32),
});

export type Config = z.infer<typeof Env>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);
