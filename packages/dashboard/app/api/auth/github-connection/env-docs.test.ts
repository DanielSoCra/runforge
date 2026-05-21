import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

describe('GitHub OAuth env vars documented in .env.prod.example', () => {
  const envExample = readFileSync(
    resolve(__dir, '../../../../../../.env.prod.example'),
    'utf-8',
  );

  it('documents GITHUB_OAUTH_CLIENT_ID', () => {
    expect(envExample).toContain('GITHUB_OAUTH_CLIENT_ID=');
  });

  it('documents GITHUB_OAUTH_CLIENT_SECRET', () => {
    expect(envExample).toContain('GITHUB_OAUTH_CLIENT_SECRET=');
  });

  it('does not document retired Supabase service-role env names', () => {
    const lines = envExample.split('\n');
    const retiredSupabaseLines = lines.filter((line) =>
      /^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY)=/.test(line),
    );
    expect(retiredSupabaseLines).toHaveLength(0);
  });
});
