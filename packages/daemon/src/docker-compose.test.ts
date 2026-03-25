import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../..');

describe('docker-compose.yml daemon env vars', () => {
  const raw = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf-8');

  it('should forward SUPABASE_URL to the daemon', () => {
    expect(raw).toContain('SUPABASE_URL');
  });

  it('should use an env_file for secrets (SERVICE_ROLE_KEY etc come from env_file)', () => {
    expect(raw).toContain('env_file');
  });
});

describe('.dockerignore excludes secret files (#183)', () => {
  const dockerignore = readFileSync(resolve(REPO_ROOT, '.dockerignore'), 'utf-8');

  it('excludes .env.prod (production secrets)', () => {
    // .dockerignore must have a pattern that matches .env.prod
    // Either literal '.env.prod' or a glob like '.env*'
    const patterns = dockerignore.split('\n').map((l) => l.trim()).filter(Boolean);
    const matchesEnvProd = patterns.some((p) =>
      p === '.env.prod' || p === '.env*' || p === '.env.*',
    );
    expect(matchesEnvProd).toBe(true);
  });

  it('excludes .env (base secrets)', () => {
    const patterns = dockerignore.split('\n').map((l) => l.trim()).filter(Boolean);
    const matchesEnv = patterns.some((p) =>
      p === '.env' || p === '.env*',
    );
    expect(matchesEnv).toBe(true);
  });
});

describe('docker-compose dashboard port binding (#391)', () => {
  const raw = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf-8');

  it('should default DASHBOARD_PORT to loopback binding, not bare port', () => {
    // A bare port like "3000" binds to 0.0.0.0 (all interfaces), exposing the
    // dashboard publicly. The default must include 127.0.0.1 to bind to loopback.
    expect(raw).toContain('${DASHBOARD_PORT:-127.0.0.1:3000:3000}');
  });

  it('should NOT have a bare port default for the dashboard', () => {
    // Ensure we don't regress to a bare port number default
    expect(raw).not.toMatch(/DASHBOARD_PORT:-\d+\}/);
  });
});

describe('docker-compose git config', () => {
  const composeFiles = ['docker-compose.yml', 'docker-compose.prod.yml']
    .filter((f) => existsSync(resolve(REPO_ROOT, f)));

  for (const file of composeFiles) {
    describe(file, () => {
      const raw = readFileSync(resolve(REPO_ROOT, file), 'utf-8');

      it('should configure git user.name for daemon service', () => {
        expect(raw).toContain("git config --global user.name");
      });

      it('should configure git user.email for daemon service', () => {
        expect(raw).toContain("git config --global user.email");
      });
    });
  }
});
