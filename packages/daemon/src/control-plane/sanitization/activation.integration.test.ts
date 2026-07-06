// GATE (immovable) — TRUE end-to-end backend activation over the REAL ledger + store.
//
// Proves the whole 5a chain: a configured withholding sanitizer rewrites a decision field to a
// protected:// ref at ingest; raising that request stores the ref; the read-model DETAIL surfaces
// the field as { kind: 'protected', class, ref }; and the original is recoverable via store.get(ref)
// — i.e. the operator reveal (5b) is possible. Also pins idempotency across retries and the
// DecisionIndexManager.protectedStore() exposure (fail-closed when the index is disabled).
//
// The real writer opens a postgres-js connection, so the writer-backed chain is gated on a real
// Postgres URL; the disabled fail-closed check (no writer) runs unconditionally.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@runforge/decision-protocol';
import { createIndexWriter, type IndexWriter } from '@runforge/decision-index';
import { LogNotifier, RecordingSourceSink, AckResumeDispatcher } from '../decision-escalation/adapters.js';
import { DecisionLedger } from '../decision-escalation/ledger.js';
import { DecisionIndexManager } from '../decision-escalation/manager.js';
import {
  DECISION_DB_URL,
  REAL_PG,
  makeSchemaSerializer,
} from '../decision-escalation/__fixtures__/pg-test-harness.js';
import { buildSanitizationPipeline } from './build-pipeline.js';
import type { DeploymentProfile } from '../deployment-registry/types.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const FIXED_NOW = '2026-06-02T00:00:00.000Z';

const profileWith = (fields: string[]): DeploymentProfile =>
  ({
    id: 'dep-a',
    repositories: [{ owner: 'acme', name: 'runforge' }],
    riskPathMap: [{ paths: ['infra/**'], minLevel: 'orange' }],
    defaultMinLevel: 'green',
    laneSet: { declaredPhases: ['velocity'], mostCautiousLane: 'standard', lanes: [] },
    lifecycleMode: 'velocity',
    complianceReviewers: [],
    honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
    budget: 5000,
    landing: { landsOn: 'main', productionReleasePath: { kind: 'trigger-automated', trigger: 'tag-and-deploy' } },
    capabilityBindings: [],
    sanitizers: [{ plugin: 'withholding', options: { fields, class: 'secret' } }],
  }) as unknown as DeploymentProfile;

function makeRequest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    decision_id: 'issue-42:l2-gate:1',
    protocol_version: PROTOCOL_VERSION,
    source_url: 'https://example.test/issues/42',
    source_etag: 'etag-0',
    deployment: 'test',
    run_id: 'issue-42',
    worker_session_id: 'ws-1',
    phase: 'l2-gate',
    risk_class: 'P1',
    question: 'Approve the L2 architecture?',
    context: 'l2-gate review for issue 42',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    consequence_of_no_answer: 'run stays parked',
    reversibility: 'reversible',
    expires_at: '2026-06-09T00:00:00.000Z',
    answer_schema: { kind: 'option' },
    resume_mode: 'requeue',
    idempotency_key: 'issue-42:l2-gate:1',
    ...overrides,
  };
}

describe.skipIf(!REAL_PG)('sanitizer activation — end-to-end withhold -> raise -> read-model -> reveal (real Postgres)', () => {
  const serializer = makeSchemaSerializer();
  const dirs: string[] = [];
  const writers: IndexWriter[] = [];

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'pmps-act-'));
    dirs.push(d);
    return d;
  }

  async function makeWriter(): Promise<{ writer: IndexWriter; ledger: DecisionLedger; dir: string }> {
    const dir = tmp();
    const writer = await createIndexWriter({
      databaseUrl: DECISION_DB_URL!,
      protectedKey: KEY,
      protectedDir: join(dir, 'protected'),
      notifier: new LogNotifier(),
      sourceSink: new RecordingSourceSink(),
      resumeDispatcher: new AckResumeDispatcher(),
      clock: () => new Date(FIXED_NOW),
    });
    writers.push(writer);
    return { writer, ledger: new DecisionLedger(writer), dir };
  }

  beforeAll(() => serializer.lock());
  afterAll(() => serializer.release());

  beforeEach(() => serializer.resetSchema());
  afterEach(async () => {
    for (const w of writers.splice(0)) await w.close().catch(() => {});
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('a withheld field is stored as a ref, surfaced as protected in detail, and revealable', async () => {
    const { writer, ledger } = await makeWriter();
    const pipeline = buildSanitizationPipeline(profileWith(['context']), {
      protectedStore: writer.protectedStore,
    });

    // ingest-seam behavior: sanitize the raw content keyed by the decision id.
    const decisionId = 'issue-42:l2-gate:1';
    const sanitized = await pipeline.run({
      content: { context: 'SENSITIVE-CONTEXT' },
      subjectRef: decisionId,
    });
    expect(sanitized.content.context as string).toMatch(/^protected:\/\//);

    // raise the sanitized request, then read it back via the dashboard read-model.
    const r = await ledger.raise(makeRequest({ context: sanitized.content.context }));
    expect(r.outcome).toBe('admitted');
    const detail = (await writer.reader.detail(decisionId))!;
    const ctxField = detail.context!;
    expect(ctxField).toEqual({
      kind: 'protected',
      field: 'context',
      class: 'secret',
      ref: sanitized.content.context,
    });
    if (ctxField.kind !== 'protected') throw new Error('expected a protected field');

    // reveal: the protected ref decrypts back to the original (this is what 5b will call).
    expect(JSON.parse(await writer.protectedStore.get(ctxField.ref))).toBe('SENSITIVE-CONTEXT');

    await writer.close();
  });

  it('is idempotent: re-running the seam yields the same ref (re-raise stays unchanged)', async () => {
    const { writer } = await makeWriter();
    const pipeline = buildSanitizationPipeline(profileWith(['context']), {
      protectedStore: writer.protectedStore,
    });
    const a = await pipeline.run({ content: { context: 'X' }, subjectRef: 'issue-7:l2-gate:1' });
    const b = await pipeline.run({ content: { context: 'X' }, subjectRef: 'issue-7:l2-gate:1' });
    expect(b.content.context).toBe(a.content.context);
    await writer.close();
  });

  it('an EDITED field (same id, changed value) mints a fresh ref revealing the new value', async () => {
    const { writer } = await makeWriter();
    const pipeline = buildSanitizationPipeline(profileWith(['context']), {
      protectedStore: writer.protectedStore,
    });
    const a = await pipeline.run({ content: { context: 'OLD' }, subjectRef: 'issue-9:l2-gate:1' });
    const b = await pipeline.run({ content: { context: 'NEW' }, subjectRef: 'issue-9:l2-gate:1' });
    expect(b.content.context).not.toBe(a.content.context);
    expect(JSON.parse(await writer.protectedStore.get(b.content.context as string))).toBe('NEW');
    await writer.close();
  });
});

// The disabled fail-closed check opens NO writer (init() is a no-op), so it needs no Postgres.
describe('sanitizer activation — protected store exposure is fail-closed when disabled', () => {
  it('exposes the protected store only when the index is enabled (fail-closed otherwise)', async () => {
    const disabled = new DecisionIndexManager({
      enabled: false,
      databaseUrl: 'postgres://unused',
      protectedKey: '',
      protectedDir: 'unused',
    });
    await disabled.init();
    expect(() => disabled.protectedStore()).toThrow();
  });
});
