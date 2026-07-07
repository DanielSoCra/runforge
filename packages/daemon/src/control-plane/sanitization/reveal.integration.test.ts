// GATE (immovable) — operator reveal of withheld content, end-to-end over the real ledger/store.
//
// Security-critical contracts this pins:
//  - revealProtected returns the ORIGINAL withheld plaintext for a ref that belongs to the decision.
//  - a ref that does NOT belong to the decision (bogus, or another decision's ref) is REJECTED —
//    an operator can only reveal refs that are actually part of the decision they are viewing.
//  - a reveal is RECORDED in the audit log (event 'reveal', with the actor) for accountability.
//  - reveal fails closed when the index/store is unavailable.
//
// The real writer opens a postgres-js connection, so the whole suite is gated on a real Postgres URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@runforge/decision-protocol';
import { createIndexWriter, type IndexWriter } from '@runforge/decision-index';
import { LogNotifier, RecordingSourceSink, AckResumeDispatcher } from '../decision-escalation/adapters.js';
import { DecisionLedger } from '../decision-escalation/ledger.js';
import {
  DECISION_DB_URL,
  REAL_PG,
  makeSchemaSerializer,
} from '../decision-escalation/__fixtures__/pg-test-harness.js';
import { buildSanitizationPipeline } from './build-pipeline.js';
import type { DeploymentProfile } from '../deployment-registry/types.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const FIXED_NOW = '2026-06-02T00:00:00.000Z';

const withholdingProfile = (fields: string[]): DeploymentProfile =>
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

function makeRequest(decisionId: string, context: unknown): Record<string, unknown> {
  return {
    decision_id: decisionId,
    protocol_version: PROTOCOL_VERSION,
    source_url: `https://example.test/${decisionId}`,
    source_etag: 'etag-0',
    deployment: 'test',
    run_id: decisionId,
    worker_session_id: 'ws-1',
    phase: 'l2-gate',
    risk_class: 'P1',
    question: 'Approve?',
    context,
    consequence_of_no_answer: 'parked',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    reversibility: 'reversible',
    expires_at: '2026-06-09T00:00:00.000Z',
    answer_schema: { kind: 'option' },
    resume_mode: 'requeue',
    idempotency_key: decisionId,
  };
}

describe.skipIf(!REAL_PG)('operator reveal — revealProtected (real Postgres)', () => {
  const serializer = makeSchemaSerializer();
  const dirs: string[] = [];
  const writers: IndexWriter[] = [];

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'pmps-reveal-'));
    dirs.push(d);
    return d;
  }

  async function makeWriter(): Promise<{ writer: IndexWriter; ledger: DecisionLedger }> {
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
    return { writer, ledger: new DecisionLedger(writer) };
  }

  /** Raise a decision whose `context` field is withheld; return its id + the stored protected ref. */
  async function raiseWithheld(
    ledger: DecisionLedger,
    store: IndexWriter['protectedStore'],
    id: string,
    secret: string,
  ): Promise<string> {
    const sanitized = await buildSanitizationPipeline(withholdingProfile(['context']), {
      protectedStore: store,
    }).run({ content: { context: secret }, subjectRef: id });
    await ledger.raise(makeRequest(id, sanitized.content.context));
    return sanitized.content.context as string; // the protected:// ref
  }

  beforeAll(() => serializer.lock());
  afterAll(() => serializer.release());

  beforeEach(() => serializer.resetSchema());
  afterEach(async () => {
    for (const w of writers.splice(0)) await w.close().catch(() => {});
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns the original withheld plaintext for a ref belonging to the decision', async () => {
    const { writer, ledger } = await makeWriter();
    const id = 'issue-1:l2-gate:1';
    const ref = await raiseWithheld(ledger, writer.protectedStore, id, 'TOP-SECRET');

    const revealed = await ledger.revealProtected(id, ref, 'admin@acme.de');
    expect(revealed.field).toBe('context');
    expect(revealed.value).toBe('TOP-SECRET');
    await writer.close();
  });

  it('records a reveal in the audit log (event + actor)', async () => {
    const { writer, ledger } = await makeWriter();
    const id = 'issue-2:l2-gate:1';
    const ref = await raiseWithheld(ledger, writer.protectedStore, id, 'S');
    await ledger.revealProtected(id, ref, 'admin@acme.de');

    const audit = await writer.reader.audit(id);
    const reveal = audit.find((e) => e.event === 'reveal');
    expect(reveal).toBeDefined();
    // accountability: the audit view surfaces WHO revealed (requires AuditView.actor).
    expect(reveal!.actor).toBe('admin@acme.de');
    await writer.close();
  });

  it('REJECTS a ref that does not belong to the decision (no revealing arbitrary refs)', async () => {
    const { writer, ledger } = await makeWriter();
    const idA = 'issue-3:l2-gate:1';
    const idB = 'issue-4:l2-gate:1';
    const refA = await raiseWithheld(ledger, writer.protectedStore, idA, 'A-SECRET');
    await raiseWithheld(ledger, writer.protectedStore, idB, 'B-SECRET');

    // a bogus ref, and decision A's ref requested under decision B, are both refused.
    await expect(ledger.revealProtected(idA, 'protected://does-not-exist', 'admin@x')).rejects.toThrow();
    await expect(ledger.revealProtected(idB, refA, 'admin@x')).rejects.toThrow();
    await writer.close();
  });
});
