import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cloudInit = readFileSync(
  resolve(__dirname, '../../../../infra/cloud-init.yml'),
  'utf-8',
);

describe('cloud-init.yml', () => {
  it('installs Docker', () => {
    expect(cloudInit).toContain('https://get.docker.com');
  });

  it('adds autoclaude user to docker group', () => {
    expect(cloudInit).toContain('usermod -aG docker autoclaude');
  });

  it('uses correct username "autoclaude" (not "autoclaud")', () => {
    expect(cloudInit).not.toMatch(/autoclaud(?!e)/);
    expect(cloudInit).toContain('useradd -m -s /bin/bash autoclaude');
  });

  it('installs Docker before adding user to docker group', () => {
    const dockerInstallIndex = cloudInit.indexOf('https://get.docker.com');
    const usermodIndex = cloudInit.indexOf('usermod -aG docker autoclaude');
    expect(dockerInstallIndex).toBeLessThan(usermodIndex);
  });
});
