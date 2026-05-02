// Public surface of @card-pricer/db.
// Server code does `import { db, schema } from '@card-pricer/db'`.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Lazy singleton. Don't instantiate at module load — env vars may not be ready
 * (esp. in tests / CI typecheck). First call wires the connection.
 */
export function getDb() {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The DB package needs the Supabase Postgres connection string.',
    );
  }
  const client = postgres(url, { prepare: false });
  _db = drizzle(client, { schema });
  return _db;
}

export { schema };
