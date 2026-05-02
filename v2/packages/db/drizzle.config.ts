import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Don't drop existing tables — we share Postgres with v1 during cutover.
  strict: true,
  verbose: true,
});
