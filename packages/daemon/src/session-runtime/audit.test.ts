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
});
