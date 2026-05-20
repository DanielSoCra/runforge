import { z } from 'zod';

const DatabaseUrl = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'postgres:' || protocol === 'postgresql:';
  }, 'must use postgres:// or postgresql://');

export interface DatabaseEnv {
  AUTO_CLAUDE_DATABASE_URL?: string;
}

export function readDatabaseUrl(
  env: DatabaseEnv = process.env as DatabaseEnv,
): string {
  const parsed = DatabaseUrl.safeParse(env.AUTO_CLAUDE_DATABASE_URL);
  if (!parsed.success) {
    throw new Error(
      'AUTO_CLAUDE_DATABASE_URL must be a valid URL before opening the project-owned Postgres store',
    );
  }
  return parsed.data;
}
