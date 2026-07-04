// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const globalSetup = readFileSync(
  new URL('./e2e/global-setup.mjs', import.meta.url),
  'utf8',
);
const operatorSurfaceSpec = readFileSync(
  new URL('./e2e/operator-surface.spec.ts', import.meta.url),
  'utf8',
);

function sliceFetchCallWithPath(source: string, path: string): string {
  const fetchPattern = /fetch\s*\(/g;
  let match = fetchPattern.exec(source);

  while (match) {
    const end = source.indexOf(');', match.index);
    if (end === -1) return '';
    const candidate = source.slice(match.index, end + 2);
    if (candidate.includes(path)) return candidate;
    match = fetchPattern.exec(source);
  }

  return '';
}

function sliceGlobalSetupBody(): string {
  return (
    globalSetup
      .split(/export\s+default\s+async\s+function\s+globalSetup\s*\(\s*\)\s*\{/)[1]
      ?.split(/\n\}/)[0] ??
    globalSetup
      .split(/async\s+function\s+globalSetup\s*\(\s*\)\s*\{/)[1]
      ?.split(/\n\}/)[0] ??
    ''
  );
}

function sliceAnsweringDecisionTestBody(): string {
  return (
    operatorSurfaceSpec
      .split(/test\('answering a decision posts through the real daemon and the row leaves'/)[1]
      ?.split(/\n {2}test\(/)[0] ?? ''
  );
}

const answeredBadgeExpectation =
  /expect\(\s*page\.getByText\(\s*\/answered\/i\s*\)\.first\(\)\s*\)\.toBeVisible\(\s*\)/;

describe('answer-flow hardening acceptance gate (immovable)', () => {
  it('global-setup.mjs warms POST /api/decisions/answer with a JSON answer body', () => {
    const answerWarmup = sliceFetchCallWithPath(
      globalSetup,
      '/api/decisions/answer',
    );

    expect(answerWarmup).not.toBe('');
    expect(answerWarmup).toMatch(/\bmethod\s*:\s*['"`]POST['"`]/);
    expect(answerWarmup).toMatch(
      /\bbody\s*:\s*JSON\.stringify\s*\(\s*\{[\s\S]*?\bdecision_id\s*:/,
    );
    expect(answerWarmup).toMatch(
      /\bbody\s*:\s*JSON\.stringify\s*\(\s*\{[\s\S]*?\bchosen_option\s*:/,
    );
  });

  it('globalSetup calls the answer-route warm-up', () => {
    const body = sliceGlobalSetupBody();

    expect(body).not.toBe('');
    expect(body).toMatch(/\bwarmAnswerRoute\s*\(\s*\)/);
  });

  it('the answer test binds a POST /api/decisions/answer wait before the badge expect', () => {
    const body = sliceAnsweringDecisionTestBody();
    const badgeIndex = body.search(answeredBadgeExpectation);
    const beforeBadge = body.slice(0, badgeIndex);
    const waitForResponseIndex = beforeBadge.search(/page\.waitForResponse\s*\(/);
    const waitForResponseBlock = beforeBadge.slice(waitForResponseIndex);

    expect(body).not.toBe('');
    expect(badgeIndex).toBeGreaterThanOrEqual(0);
    expect(beforeBadge).toMatch(
      /const\s+\[\s*answerResponse\s*\]\s*=\s*await\s+Promise\.all\s*\(\s*\[[\s\S]*?page\.waitForResponse\s*\(/,
    );
    expect(waitForResponseIndex).toBeGreaterThanOrEqual(0);
    expect(waitForResponseBlock).toMatch(
      /\.url\(\)\.includes\(\s*['"`]\/api\/decisions\/answer['"`]\s*\)/,
    );
    expect(waitForResponseBlock).toMatch(
      /\.request\(\)\.method\(\)\s*={2,3}\s*['"`]POST['"`]/,
    );
  });

  it('the answer test asserts the POST response is ok before the answered badge expect', () => {
    const body = sliceAnsweringDecisionTestBody();
    const okIndex = body.search(
      /expect\(\s*answerResponse\.ok\(\)\s*\)\.toBe\(\s*true\s*\)/,
    );
    const badgeIndex = body.search(answeredBadgeExpectation);

    expect(body).not.toBe('');
    expect(okIndex).toBeGreaterThanOrEqual(0);
    expect(badgeIndex).toBeGreaterThanOrEqual(0);
    expect(okIndex).toBeLessThan(badgeIndex);
  });
});
