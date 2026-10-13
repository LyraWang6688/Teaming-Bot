import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getDatabaseUrl } from '@/lib/platform/env';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export type DbExecutor = Pick<Database, 'select' | 'insert' | 'update' | 'execute'>;

const globalForDb = globalThis as typeof globalThis & {
  __feishuDbPool?: Pool;
  __feishuDb?: Database;
};

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 连接与查询超时。生产事故复盘（2026-09-30）：
 *
 * 生产连的是 Supabase 池化器（pooler.supabase.com:6543），中间层会静默丢弃连接。
 * 此前 Pool **一个超时都没配**，于是某次查询的 socket 断了、promise 却永远不 settle，
 * 让 `await` 无限挂起。
 *
 * 挂起本身不致命，致命的是 worker 的重新排程写在 `finally` 里——
 * await 不返回，`finally` 就不执行，循环永久死亡，**而且一条日志都不打**
 * （不是抛错，是卡住）。结果是流水线静默停摆 13 天，51 条任务积压。
 *
 * 加超时的目的：把"无限挂起"变成"可捕获的错误"。
 * 阈值可用环境变量覆盖，默认值按"本项目的查询都是短操作"设定——
 * 注意 LLM 分析、妙记导出等长耗时调用都发生在事务之外，不受这些超时影响。
 */
const CONNECT_TIMEOUT_MS = readPositiveInt(process.env.DB_CONNECT_TIMEOUT_MS, 10_000);
// 服务端中止（statement_timeout）略短于客户端放弃（query_timeout），
// 这样先拿到服务端的明确报错，而不是客户端的模糊超时。
const STATEMENT_TIMEOUT_MS = readPositiveInt(process.env.DB_STATEMENT_TIMEOUT_MS, 30_000);
const QUERY_TIMEOUT_MS = readPositiveInt(process.env.DB_QUERY_TIMEOUT_MS, 35_000);

function createPool(): Pool {
  return new Pool({
    connectionString: getDatabaseUrl(),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
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
