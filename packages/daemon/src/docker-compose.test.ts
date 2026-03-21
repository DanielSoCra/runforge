import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../..');

describe('docker-compose git config', () => {
  const composeFiles = ['docker-compose.yml', 'docker-compose.prod.yml'];

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
