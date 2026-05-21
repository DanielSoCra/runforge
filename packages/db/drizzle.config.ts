import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.AUTO_CLAUDE_DATABASE_URL ??
      'postgres://postgres:postgres@localhost:5432/auto_claude',
  },
} satisfies Config;
