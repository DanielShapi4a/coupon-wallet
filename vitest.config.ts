import { defineConfig } from 'vitest/config';

// The mobile app is tested with jest-expo inside apps/mobile (ADR-002).
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts'],
  },
});
