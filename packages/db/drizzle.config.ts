import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.RUNFORGE_DATABASE_URL ??
      'postgres://postgres:postgres@localhost:5432/runforge',
  },
} satisfies Config;
