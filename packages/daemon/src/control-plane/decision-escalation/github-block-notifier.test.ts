/**
 * Tests for the GitHub decision-request BLOCK publisher (Slice 1 of the
 * decision-loop wiring: daemon -> pm-cockpit inbox).
 *
 * The publisher is the missing physical wire: it embeds a
 * `pm-cockpit:decision-request:v1` block into the gate ISSUE BODY (the surface
 * the cockpit's issue-poller actually reads — confirmed in
 * pm-cockpit/.../github/issue-poller.ts which calls extractDecisionBlock(issue.body)).
 *
 * The KEY test is the CROSS-REPO ACCEPTANCE test: it feeds a rendered block back
 * through a VENDORED COPY of pm-cockpit's extraction logic + validates the
 * extracted JSON against a VENDORED COPY of pm-cockpit's committed
 * `packages/protocol/schema/decision-request.schema.json` (in __fixtures__/)
 * using ajv. That proves the cockpit will ACCEPT what we emit, with no live
 * cockpit and no network.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, type Mock } from 'vitest';
import AjvModule from 'ajv';
import { DecisionRequestSchema } from '@auto-claude/decision-protocol';
import {
  BLOCK_START,
  BLOCK_END,
  renderDecisionBlock,
  embedDecisionBlock,
  validateRenderedBlock,
  GitHubBlockPublisher,
  type OctokitLike,
} from './github-block-notifier.js';
import type { DecisionRequest } from '@auto-claude/decision-protocol';

const HERE = dirname(fileURLToPath(import.meta.url));

// ajv 8 ships a CJS `module.exports = Ajv` plus `.default`; under NodeNext unwrap.
type AjvCtor = typeof AjvModule.default;
const Ajv: AjvCtor =
  (AjvModule as unknown as { default?: AjvCtor }).default ??
  (AjvModule as unknown as AjvCtor);

/** The exact block-extraction regex pm-cockpit uses (vendored from decision-block.ts). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const COCKPIT_BLOCK_RE = new RegExp(
  `${escapeRe(BLOCK_START)}\\s*\\u0060\\u0060\\u0060json\\s*([\\s\\S]*?)\\s*\\u0060\\u0060\\u0060\\s*${escapeRe(
    BLOCK_END,
  )}`,
);
function cockpitExtract(body: string): string | null {
  const m = COCKPIT_BLOCK_RE.exec(body);
  return m ? m[1]!.trim() : null;
}

/** A representative, schema-valid l2-gate DecisionRequest. */
function makeRequest(overrides: Record<string, unknown> = {}) {
  return DecisionRequestSchema.parse({
    decision_id: 'issue-42:l2-gate:1',
    source_url: 'https://github.com/owner/repo/issues/42',
    deployment: 'owner/repo',
    run_id: 'issue-42',
    worker_session_id: 'run-42',
    phase: 'l2-gate',
    risk_class: 'P1',
    question: 'Approve the L2 architecture for issue #42?',
    context:
      'Run issue-42 parked at the l2-gate phase awaiting Operator review.',
    options: [
      {
        id: 'approve',
        label: 'Approve the L2 architecture and resume the pipeline.',
      },
      { id: 'reject', label: 'Reject and send back to L2 design for rework.' },
    ],
    consequence_of_no_answer:
      'The run stays parked at the l2-gate phase until an Operator approves or rejects.',
    reversibility: 'reversible',
    expires_at: '2026-06-09T00:00:00.000Z',
    answer_schema: { kind: 'option' },
    resume_mode: 'requeue',
    idempotency_key: 'issue-42:l2-gate:1',
    ...overrides,
  });
}

interface MockOctokit extends OctokitLike {
  issues: { get: Mock; update: Mock; addLabels: Mock };
}

function makeOctokit(): MockOctokit {
  return {
    issues: {
      get: vi.fn(async () => ({
        data: { body: 'Original human body.', labels: [] },
      })),
      update: vi.fn(async () => ({})),
      addLabels: vi.fn(async () => ({})),
    },
  };
}

describe('renderDecisionBlock', () => {
  it('wraps the canonical JSON in the cockpit v1 markers + a json fence', () => {
    const block = renderDecisionBlock(makeRequest());
    expect(block.startsWith(BLOCK_START)).toBe(true);
    expect(block.trimEnd().endsWith(BLOCK_END)).toBe(true);
    expect(block).toContain('```json');
    // the extracted payload round-trips to the same canonical request
    const json = cockpitExtract(block);
    expect(json).not.toBeNull();
    expect(JSON.parse(json!).decision_id).toBe('issue-42:l2-gate:1');
  });
});

describe('CROSS-REPO ACCEPTANCE: cockpit accepts what we emit', () => {
  it('extracts + validates against the VENDORED pm-cockpit committed JSON Schema (ajv)', () => {
    // Vendored from pm-cockpit/packages/protocol/schema/decision-request.schema.json
    const schema = JSON.parse(
      readFileSync(
        join(HERE, '__fixtures__', 'pm-cockpit-decision-request.schema.json'),
        'utf-8',
      ),
    );
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    const body = embedDecisionBlock(
      'Human-authored issue body.',
      renderDecisionBlock(makeRequest()),
    );

    // 1) the cockpit's extraction finds the block in the body
    const rawJson = cockpitExtract(body);
    expect(rawJson).not.toBeNull();

    // 2) the extracted JSON validates against the cockpit's committed schema
    const obj = JSON.parse(rawJson!);
    const ok = validate(obj);
    if (!ok) {
      throw new Error(
        `cockpit schema rejected our block: ${ajv.errorsText(validate.errors, { dataVar: 'block' })}`,
      );
    }
    expect(ok).toBe(true);
  });
});

describe('embedDecisionBlock (idempotent body embed)', () => {
  it('appends the block when the body has none, preserving the human content', () => {
    const block = renderDecisionBlock(makeRequest());
    const out = embedDecisionBlock('Human body line 1.\nLine 2.', block);
    expect(out).toContain('Human body line 1.');
    expect(out).toContain('Line 2.');
    expect(cockpitExtract(out)).not.toBeNull();
    // exactly one block
    expect(out.split(BLOCK_START).length - 1).toBe(1);
  });

  it('embedding twice yields exactly ONE block (idempotent)', () => {
    const block = renderDecisionBlock(makeRequest());
    const once = embedDecisionBlock('Human body.', block);
    const twice = embedDecisionBlock(once, block);
    expect(twice.split(BLOCK_START).length - 1).toBe(1);
    expect(twice.split(BLOCK_END).length - 1).toBe(1);
  });

  it('REPLACES an existing block in place (new epoch wins) and preserves human content', () => {
    const old = renderDecisionBlock(
      makeRequest({
        decision_id: 'issue-42:l2-gate:1',
        idempotency_key: 'issue-42:l2-gate:1',
      }),
    );
    const next = renderDecisionBlock(
      makeRequest({
        decision_id: 'issue-42:l2-gate:2',
        idempotency_key: 'issue-42:l2-gate:2',
      }),
    );
    const bodyWithOld = embedDecisionBlock('KEEP THIS HUMAN TEXT.', old);
    const replaced = embedDecisionBlock(bodyWithOld, next);
    expect(replaced).toContain('KEEP THIS HUMAN TEXT.');
    expect(replaced.split(BLOCK_START).length - 1).toBe(1);
    const json = cockpitExtract(replaced);
    expect(JSON.parse(json!).decision_id).toBe('issue-42:l2-gate:2');
  });

  it('FAILS CLOSED (throws) on a malformed body with multiple/unbalanced markers', () => {
    const block = renderDecisionBlock(makeRequest());
    const twoStarts = `${BLOCK_START}\nx\n${BLOCK_START}\n${BLOCK_END}`;
    expect(() => embedDecisionBlock(twoStarts, block)).toThrow();
    const unbalanced = `${BLOCK_START}\nno end marker here`;
    expect(() => embedDecisionBlock(unbalanced, block)).toThrow();
  });
});

describe('validateRenderedBlock (fail-closed gate)', () => {
  it('accepts a schema-valid rendered block', () => {
    const res = validateRenderedBlock(renderDecisionBlock(makeRequest()));
    expect(res.valid).toBe(true);
  });

  it('rejects a block whose JSON is missing a required field (no false-accept)', () => {
    // hand-build a block with a request missing `context`
    const bad = { decision_id: 'x', source_url: 'u', deployment: 'd' };
    const block = `${BLOCK_START}\n\`\`\`json\n${JSON.stringify(bad, null, 2)}\n\`\`\`\n${BLOCK_END}`;
    const res = validateRenderedBlock(block);
    expect(res.valid).toBe(false);
    expect(res.reason).toBeTruthy();
  });
});

describe('GitHubBlockPublisher.ensure', () => {
  it('FAIL-CLOSED: a malformed/incomplete request is NOT written (no GitHub API call)', async () => {
    const octokit = makeOctokit();
    const pub = new GitHubBlockPublisher();
    // a request missing required fields fails the fail-closed gate
    const badRequest = {
      ...makeRequest(),
      context: undefined,
    } as unknown as DecisionRequest;
    const res = await pub.ensure({
      request: badRequest,
      octokit,
      owner: 'owner',
      repo: 'repo',
      issueNumber: 42,
    });
    expect(res.posted).toBe(false);
    expect(res.reason).toBeTruthy();
    expect(octokit.issues.get).not.toHaveBeenCalled();
    expect(octokit.issues.update).not.toHaveBeenCalled();
    expect(octokit.issues.addLabels).not.toHaveBeenCalled();
  });

  it('embeds the block into the issue BODY then applies the decision label (body-first ordering)', async () => {
    const octokit = makeOctokit();
    const order: string[] = [];
    octokit.issues.update.mockImplementation(async () => {
      order.push('update');
      return {};
    });
    octokit.issues.addLabels.mockImplementation(async () => {
      order.push('addLabels');
      return {};
    });
    const pub = new GitHubBlockPublisher();
    const res = await pub.ensure({
      request: makeRequest(),
      octokit,
      owner: 'owner',
      repo: 'repo',
      issueNumber: 42,
    });
    expect(res.posted).toBe(true);
    expect(octokit.issues.update).toHaveBeenCalledTimes(1);
    const updateArg = octokit.issues.update.mock.calls[0]![0];
    expect(updateArg.issue_number).toBe(42);
    expect(updateArg.body).toContain(BLOCK_START);
    expect(updateArg.body).toContain('Original human body.');
    expect(octokit.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['decision-request'] }),
    );
    // body BEFORE label so a labeled issue always carries a block
    expect(order).toEqual(['update', 'addLabels']);
  });

  it('honors a configurable decision label', async () => {
    const octokit = makeOctokit();
    const pub = new GitHubBlockPublisher({ decisionLabel: 'pm-decision' });
    await pub.ensure({
      request: makeRequest(),
      octokit,
      owner: 'owner',
      repo: 'repo',
      issueNumber: 42,
    });
    expect(octokit.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['pm-decision'] }),
    );
  });

  it('IDEMPOTENT: a second ensure with the same request does not re-write the body (already embedded)', async () => {
    // simulate the issue already carrying our exact block
    const block = renderDecisionBlock(makeRequest());
    const embedded = embedDecisionBlock('Original human body.', block);
    const octokit = makeOctokit();
    octokit.issues.get.mockResolvedValue({
      data: { body: embedded, labels: [{ name: 'decision-request' }] },
    });
    const pub = new GitHubBlockPublisher();
    const res = await pub.ensure({
      request: makeRequest(),
      octokit,
      owner: 'owner',
      repo: 'repo',
      issueNumber: 42,
    });
    expect(res.posted).toBe(true);
    // body already identical -> no redundant update
    expect(octokit.issues.update).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: a GitHub body-write failure surfaces as posted:false and does NOT add the label', async () => {
    const octokit = makeOctokit();
    octokit.issues.update.mockRejectedValue(new Error('GitHub 500'));
    const pub = new GitHubBlockPublisher();
    const res = await pub.ensure({
      request: makeRequest(),
      octokit,
      owner: 'owner',
      repo: 'repo',
      issueNumber: 42,
    });
    expect(res.posted).toBe(false);
    expect(octokit.issues.addLabels).not.toHaveBeenCalled();
  });
});
