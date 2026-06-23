import type { Config } from 'drizzle-kit';

if (!process.env.DATABASE_URL) {
  throw new Error('执行 Drizzle 命令前请先设置 DATABASE_URL');
}

export default {
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
} satisfies Config;
