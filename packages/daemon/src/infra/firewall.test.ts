import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainTf = readFileSync(
  resolve(__dirname, '../../../../infra/main.tf'),
  'utf-8',
);

describe('infra/main.tf firewall rules', () => {
  it('SSH rule does not allow access from 0.0.0.0/0', () => {
    // Extract the SSH rule block (port "22")
    const sshRuleMatch = mainTf.match(
      /rule\s*\{[^}]*port\s*=\s*"22"[^}]*\}/s,
    );
    expect(sshRuleMatch).not.toBeNull();
    const sshRule = sshRuleMatch![0];
    expect(sshRule).not.toContain('0.0.0.0/0');
    expect(sshRule).not.toContain('::/0');
  });

  it('SSH rule restricts to operator IP variables', () => {
    const sshRuleMatch = mainTf.match(
      /rule\s*\{[^}]*port\s*=\s*"22"[^}]*\}/s,
    );
    expect(sshRuleMatch).not.toBeNull();
    const sshRule = sshRuleMatch![0];
    expect(sshRule).toContain('var.my_ipv6');
    expect(sshRule).toContain('var.my_ipv4');
  });

  it('daemon API rule restricts to operator IPs', () => {
    const daemonRuleMatch = mainTf.match(
      /rule\s*\{[^}]*port\s*=\s*"3847"[^}]*\}/s,
    );
    expect(daemonRuleMatch).not.toBeNull();
    const daemonRule = daemonRuleMatch![0];
    expect(daemonRule).not.toContain('0.0.0.0/0');
    expect(daemonRule).toContain('var.my_ipv6');
    expect(daemonRule).toContain('var.my_ipv4');
  });
});
