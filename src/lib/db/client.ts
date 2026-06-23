import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getDatabaseUrl } from '@/lib/platform/env';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as typeof globalThis & {
  __feishuDbPool?: Pool;
  __feishuDb?: Database;
};

function createPool(): Pool {
  return new Pool({
    connectionString: getDatabaseUrl(),
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

export function getDb(): Database {
  if (!globalForDb.__feishuDbPool) {
    globalForDb.__feishuDbPool = createPool();
  }

  if (!globalForDb.__feishuDb) {
    globalForDb.__feishuDb = drizzle(globalForDb.__feishuDbPool, { schema });
  }

  return globalForDb.__feishuDb;
}
