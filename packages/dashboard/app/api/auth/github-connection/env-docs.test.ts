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

  it('documents SUPABASE_SERVICE_ROLE_KEY (not the wrong name SUPABASE_SERVICE_KEY)', () => {
    expect(envExample).toContain('SUPABASE_SERVICE_ROLE_KEY=');
    // Ensure the old wrong name is not present
    const lines = envExample.split('\n');
    const serviceKeyLines = lines.filter(
      (l) => l.match(/^SUPABASE_SERVICE_KEY=/) && !l.match(/^SUPABASE_SERVICE_ROLE_KEY=/),
    );
    expect(serviceKeyLines).toHaveLength(0);
  });
});
