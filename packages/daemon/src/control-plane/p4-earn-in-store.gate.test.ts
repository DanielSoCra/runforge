// P4.2 pre-approved earn-in IMMOVABLE acceptance gate — STATEFUL criteria:
// registry file-store (tmpdir JSON autonomy store), the demote-on-red trigger,
// the release-ledger PGlite debut readers, and the release executor's
// debutAuthorized recording. Groups D(11), F(17/17b/18/19b), I(26/27),
// G(22/23), J(30).
//
// Authored RED against HEAD: the earn-in node + the outcome ledger + the
// registry's `readAutonomyHistory` accessor and `demote-on-red` authorization +
// the release-ledger debut readers + the executor's `debutAuthorized` write do
// not exist yet. Net-new symbols are reached through runtime dynamic `import()`
// with the specifier widened to `string` (no TS2307, no suppression directives);
// net-new registry/reader METHODS on existing objects are reached through a
// structural cast + a `toBeTypeOf('function')` guard, so a missing method is a
// clean per-test assertion failure — never a collection/transform crash.
//
// Source of truth: docs/superpowers/plans/2026-07-03-p4-earn-in.md
// §"Immovable Acceptance-Gate SPEC" (groups D, F, G, I, J).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentRegistry, JsonFileAutonomyStore } from './deployment-registry/registry.js';
import type { AutonomyAuthorization, RiskClass, WideningRecord } from './deployment-registry/types.js';

// --------------------------------------------------------------------------
// Runtime-lookup loaders (widened specifier; missing symbol → clean failure).
// --------------------------------------------------------------------------

async function loadExport<T>(modulePath: string, name: string): Promise<T> {
  let record: Record<string, unknown> = {};
  try {
    record = (await import(modulePath)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`gate: module ${modulePath} must exist and export ${name} — ${(err as Error).message}`);
  }
  const exported = record[name];
  expect(exported, `gate: ${name} must be exported by ${modulePath}`).toBeTypeOf('function');
  return exported as T;
}

// --------------------------------------------------------------------------
// Shared signatures + fixtures (self-contained; mirrors p4-earn-in.gate.test.ts).
// --------------------------------------------------------------------------

type RiskLevel = 'green' | 'yellow' | 'orange' | 'red';
type FloorName = string;
interface EarnInFloors { minCleanMerges: number; recencyWindowDays: number; redWindowDays: number }
interface LaneTrackRecord { cleanMerges: number; bounceFreeDays: number }
type EarnInPolicy = LaneTrackRecord;
interface PromotionTrackRecord { bar: LaneTrackRecord; cleanMergesInWindow: number; redEventInWindow: boolean }
type PromotionResult =
  | { kind: 'not-eligible' }
  | { kind: 'raise-decision'; failedFloors: FloorName[] }
  | { kind: 'auto-widen'; clearedFloors: FloorName[]; evidence: PromotionTrackRecord; policyRef: string };
interface PromotionInput {
  record: PromotionTrackRecord;
  bar: EarnInPolicy | undefined;
  preApproved?: { enabled: boolean; policyRef: string };
  verifierFalsifying: boolean;
  scopeHolding: boolean;
}
type EvaluatePromotion = (i: PromotionInput) => PromotionResult;
interface LaneOutcome {
  ts: string;
  deploymentId: string;
  lane: string;
  kind: 'clean-merge' | 'bounce' | 'red';
  bounceReason?: string;
  redReason?: string;
  riskClass?: RiskLevel;
  issueNumber?: number;
}
interface WideningRecordLike {
  deploymentId: string;
  riskClass: RiskLevel;
  lane?: string;
  prior: 'human-gated' | 'widened';
  next: 'human-gated' | 'widened';
  authorization: { kind: string; [k: string]: unknown };
  recordedAt: number;
}
type DerivePromotionTrackRecord = (
  outcomes: LaneOutcome[],
  autonomyHistory: WideningRecordLike[],
  now: number,
  floors: EarnInFloors,
) => PromotionTrackRecord;
type MintPlan =
  | { kind: 'mint'; level: RiskLevel; policyRef: string; clearedFloors: string[]; evidence: unknown }
  | { kind: 'withhold-debut' }
  | { kind: 'skip' };
interface MintInput {
  promotion: PromotionResult;
  effectiveRisk: RiskLevel;
  verifierFalsifying: boolean;
  complianceForced: boolean;
  currentlyHumanGated: boolean;
  isDebut: boolean;
  hasDebutAuthorization: boolean;
}
type PlanMint = (i: MintInput) => MintPlan;
type TriggerDemoteOnRed = (d: {
  registry: DeploymentRegistry;
  stateDir: string;
  deploymentId: string;
  lane: string;
  riskClass: RiskClass;
  redReason: string;
  now: number;
}) => Promise<void>;

const FLOORS: EarnInFloors = { minCleanMerges: 10, recencyWindowDays: 30, redWindowDays: 30 };
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 3);
const isoDaysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();
const strongBar = (): EarnInPolicy => ({ cleanMerges: 10, bounceFreeDays: 30 });
const strongRecord = (): PromotionTrackRecord => ({ bar: { cleanMerges: 12, bounceFreeDays: 40 }, cleanMergesInWindow: 12, redEventInWindow: false });

// --------------------------------------------------------------------------
// Registry file-store harness (tmpdir JSON autonomy store, like the existing
// autonomy-persistence tests). One deployment 'dep-a' with lanes trivial/standard.
// --------------------------------------------------------------------------

const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) {
    const c = cleanups.pop();
    if (c) await c().catch(() => {});
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'p4-earnin-'));
  dirs.push(d);
  return d;
}

function makeProfile(over: { repositories?: { owner: string; name: string }[] } = {}) {
  return {
    repositories: over.repositories ?? [{ owner: 'acme', name: 'runforge' }],
    riskPathMap: [{ paths: ['infra/**'], minLevel: 'orange' }],
    defaultMinLevel: 'green',
    laneSet: {
      declaredPhases: ['velocity', 'clinical'],
      mostCautiousLane: 'standard',
      lanes: [
        {
          name: 'trivial',
          qualify: { complexity: ['simple'], changeKind: ['docs'] },
          allowedPaths: ['docs/**'],
          roleRouting: { implement: 'cheap-implementer' },
          gateSet: 'gate1',
          mergePolicy: 'auto',
        },
        {
          name: 'standard',
          qualify: { complexity: ['standard', 'complex'] },
          allowedPaths: ['**'],
          roleRouting: { implement: 'cheap-implementer' },
          gateSet: { velocity: 'gate1-plus', clinical: 'full' },
          mergePolicy: { velocity: 'review-then-auto', clinical: 'hold' },
        },
      ],
    },
    lifecycleMode: 'velocity',
    complianceReviewers: [{ reviewer: 'clinical-lead', condition: 'touches patient-data' }],
    honestAutomation: { automatable: ['docs'], strained: [], irreduciblyHuman: ['triage'] },
    budget: 5000,
    landing: { landsOn: 'main', productionReleasePath: { kind: 'trigger-automated', trigger: 'tag-and-deploy' } },
    capabilityBindings: [{ capability: 'classifier', version: '1.2.0' }],
  };
}

function makeRegistry(stateDir: string): DeploymentRegistry {
  const store = new JsonFileAutonomyStore(join(stateDir, 'autonomy.json'));
  const reg = new DeploymentRegistry({ autonomyStore: store });
  reg.register('dep-a', makeProfile());
  return reg;
}

function levelOf(reg: DeploymentRegistry, id: string, rc: RiskClass, lane?: string): string | undefined {
  return reg.readAutonomyState(id, rc, lane).find((e) => e.riskClass === rc)?.level;
}

// The net-new (Task 6) append-only history accessor, reached structurally so a
// missing method is a clean assertion failure (RED reason) not a TypeError crash.
function readHistory(reg: DeploymentRegistry, id: string): WideningRecord[] {
  const fn = (reg as unknown as { readAutonomyHistory?: (id: string) => WideningRecord[] }).readAutonomyHistory;
  expect(fn, 'gate: DeploymentRegistry.readAutonomyHistory accessor (Task 6) must exist').toBeTypeOf('function');
  return (fn as (id: string) => WideningRecord[]).call(reg, id);
}
const authKind = (r: WideningRecord): string => (r.authorization as unknown as { kind: string }).kind;

// ==========================================================================
// Group I — demote-on-red is level-wide + uses the demote-on-red authorization.
// ==========================================================================

describe('gate I — demote-on-red authorization + level-wide reversal', () => {
  it('27 — recordWidening accepts { kind: demote-on-red, trigger } and rejects an empty trigger', () => {
    const reg = makeRegistry(tmpDir());
    const valid = { kind: 'demote-on-red', trigger: 'red-trunk' } as unknown as AutonomyAuthorization;
    const ok = reg.recordWidening('dep-a', 'green', 'human-gated', valid, NOW);
    expect(ok.ok, 'demote-on-red must be a valid widening authorization').toBe(true);
    const empty = { kind: 'demote-on-red', trigger: '' } as unknown as AutonomyAuthorization;
    const rejected = reg.recordWidening('dep-a', 'green', 'human-gated', empty, NOW);
    expect(rejected.ok).toBe(false);
  });

  it('26 — triggerDemoteOnRed clears the class lane widenings level-wide and records the demote + a per-lane revocation', async () => {
    const stateDir = tmpDir();
    const reg = makeRegistry(stateDir);
    const grant = reg.recordWidening('dep-a', 'green', 'widened', { kind: 'operator-grant', operator: 'daniel' }, NOW, 'trivial');
    expect(grant.ok).toBe(true);
    expect(levelOf(reg, 'dep-a', 'green', 'trivial')).toBe('widened');

    const triggerDemoteOnRed = await loadExport<TriggerDemoteOnRed>('./earn-in/demote-on-red.js', 'triggerDemoteOnRed');
    await triggerDemoteOnRed({ registry: reg, stateDir, deploymentId: 'dep-a', lane: 'trivial', riskClass: 'green', redReason: 'failed-release', now: NOW + 1000 });

    // Lane widening cleared by the LEVEL-WIDE demote.
    expect(levelOf(reg, 'dep-a', 'green', 'trivial')).toBe('human-gated');
    const history = readHistory(reg, 'dep-a');
    const levelWideDemote = history.find((h) => h.next === 'human-gated' && h.lane === undefined && authKind(h) === 'demote-on-red');
    expect(levelWideDemote, 'a LEVEL-WIDE demote-on-red record').toBeDefined();
    const revocation = history.find((h) => h.lane === 'trivial' && h.riskClass === 'green' && h.next === 'human-gated');
    expect(revocation?.prior).toBe('widened');
  });
});

// ==========================================================================
// Group D (store half) — the demote trigger sets the red-window marker.
// ==========================================================================

describe('gate D — triggerDemoteOnRed sets the red-window marker over recorded outcomes', () => {
  it('11 — after the trigger, a derive over the appended red outcome yields redEventInWindow true', async () => {
    const stateDir = tmpDir();
    const reg = makeRegistry(stateDir);
    reg.recordWidening('dep-a', 'green', 'widened', { kind: 'operator-grant', operator: 'daniel' }, NOW, 'trivial');

    const triggerDemoteOnRed = await loadExport<TriggerDemoteOnRed>('./earn-in/demote-on-red.js', 'triggerDemoteOnRed');
    const laneOutcomesPath = await loadExport<(d: string) => string>('./lane-engine/outcome-ledger.js', 'laneOutcomesPath');
    const loadLaneOutcomes = await loadExport<(p: string) => Promise<LaneOutcome[]>>('./lane-engine/outcome-ledger.js', 'loadLaneOutcomes');
    const derive = await loadExport<DerivePromotionTrackRecord>('./earn-in/track-record.js', 'derivePromotionTrackRecord');

    await triggerDemoteOnRed({ registry: reg, stateDir, deploymentId: 'dep-a', lane: 'trivial', riskClass: 'green', redReason: 'failed-release', now: NOW + 1000 });

    const outcomes = (await loadLaneOutcomes(laneOutcomesPath(stateDir))).filter((o) => o.deploymentId === 'dep-a' && o.lane === 'trivial');
    expect(outcomes.some((o) => o.kind === 'red'), 'a red outcome was appended by the trigger').toBe(true);
    const record = derive(outcomes, [], NOW + 1000, FLOORS);
    expect(record.redEventInWindow).toBe(true);
  });
});

// ==========================================================================
// Group F — the mint widens the exact pair, records audit evidence, is idempotent.
// (Composes the real registry read/write with the pure evaluate/plan units — the
// mint's contract. The full phases.ts same-run auto-merge is the Task-9 integrate
// test; see the returned gate report for the deliberate scope line.)
// ==========================================================================

describe('gate F — the mint widens exactly (effectiveRisk, lane), records clearedFloors+evidence, and is idempotent', () => {
  it('17/17b/19b — one mint over two integrate passes: widens (green,trivial), records audit evidence, second pass skips', async () => {
    const reg = makeRegistry(tmpDir());
    const derive = await loadExport<DerivePromotionTrackRecord>('./earn-in/track-record.js', 'derivePromotionTrackRecord');
    const evaluatePromotion = await loadExport<EvaluatePromotion>('./earn-in/promotion-policy.js', 'evaluatePromotion');
    const planMint = await loadExport<PlanMint>('./earn-in/mint.js', 'planMint');

    // A prior witnessed debut (operator-grant on a DIFFERENT lane) so this earn-in
    // widening is not the deployment's debut — isolates the mint mechanics.
    reg.recordWidening('dep-a', 'green', 'widened', { kind: 'operator-grant', operator: 'daniel' }, NOW - DAY, 'standard');

    const outcomes: LaneOutcome[] = Array.from({ length: 12 }, (_v, i): LaneOutcome => ({
      ts: isoDaysAgo(i * 3), deploymentId: 'dep-a', lane: 'trivial', kind: 'clean-merge',
    }));
    const record = derive(outcomes, readHistory(reg, 'dep-a') as unknown as WideningRecordLike[], NOW, FLOORS);
    const promotion = evaluatePromotion({ record, bar: strongBar(), preApproved: { enabled: true, policyRef: 'ops-pack-v1' }, verifierFalsifying: true, scopeHolding: true });
    expect(promotion.kind).toBe('auto-widen');

    const isDebutNow = (): boolean => !readHistory(reg, 'dep-a').some((h) => h.next === 'widened');

    // FIRST pass: (green, trivial) is human-gated → mint.
    const plan1 = planMint({
      promotion, effectiveRisk: 'green', verifierFalsifying: true, complianceForced: false,
      currentlyHumanGated: levelOf(reg, 'dep-a', 'green', 'trivial') === 'human-gated',
      isDebut: isDebutNow(), hasDebutAuthorization: false,
    });
    expect(plan1.kind).toBe('mint');
    if (plan1.kind === 'mint') {
      const auth = { kind: 'earn-in-policy', policyRef: plan1.policyRef, clearedFloors: plan1.clearedFloors, evidence: plan1.evidence } as unknown as AutonomyAuthorization;
      const out = reg.recordWidening('dep-a', plan1.level as RiskClass, 'widened', auth, NOW, 'trivial');
      expect(out.ok).toBe(true);
    }
    // Widened EXACTLY the pair decideMerge reads.
    expect(levelOf(reg, 'dep-a', 'green', 'trivial')).toBe('widened');

    // 17b — the recorded authorization carries clearedFloors + the evidence snapshot.
    const minted = readHistory(reg, 'dep-a').find((h) => authKind(h) === 'earn-in-policy');
    expect(minted, 'an earn-in-policy widening record').toBeDefined();
    const mintedAuth = minted!.authorization as unknown as {
      clearedFloors?: unknown;
      evidence?: { cleanMerges?: unknown; cleanMergesInWindow?: unknown; bounceFreeDays?: unknown; redEventInWindow?: unknown };
    };
    expect(Array.isArray(mintedAuth.clearedFloors), 'clearedFloors recorded').toBe(true);
    expect(mintedAuth.evidence?.cleanMerges, 'evidence.cleanMerges recorded').toBeDefined();
    expect(mintedAuth.evidence?.cleanMergesInWindow, 'evidence.cleanMergesInWindow recorded').toBeDefined();
    expect(mintedAuth.evidence?.bounceFreeDays, 'evidence.bounceFreeDays recorded').toBeDefined();
    expect(mintedAuth.evidence, 'evidence.redEventInWindow recorded').toHaveProperty('redEventInWindow');

    // SECOND pass (19b): currentlyHumanGated is now false → skip → still exactly ONE mint.
    const currentlyHumanGated2 = levelOf(reg, 'dep-a', 'green', 'trivial') === 'human-gated';
    expect(currentlyHumanGated2).toBe(false);
    const plan2 = planMint({
      promotion, effectiveRisk: 'green', verifierFalsifying: true, complianceForced: false,
      currentlyHumanGated: currentlyHumanGated2, isDebut: isDebutNow(), hasDebutAuthorization: false,
    });
    expect(plan2.kind).toBe('skip');
    expect(readHistory(reg, 'dep-a').filter((h) => authKind(h) === 'earn-in-policy')).toHaveLength(1);
  });

  it('18 — a non-auto-widen evaluation mints no widening; the pair stays human-gated (escalates to the Operator)', async () => {
    const reg = makeRegistry(tmpDir());
    const evaluatePromotion = await loadExport<EvaluatePromotion>('./earn-in/promotion-policy.js', 'evaluatePromotion');
    const planMint = await loadExport<PlanMint>('./earn-in/mint.js', 'planMint');
    const promotion = evaluatePromotion({ record: strongRecord(), bar: strongBar(), preApproved: undefined, verifierFalsifying: true, scopeHolding: true });
    expect(promotion.kind).not.toBe('auto-widen');
    const plan = planMint({
      promotion, effectiveRisk: 'green', verifierFalsifying: true, complianceForced: false,
      currentlyHumanGated: true, isDebut: true, hasDebutAuthorization: false,
    });
    expect(plan.kind).toBe('skip');
    expect(levelOf(reg, 'dep-a', 'green', 'trivial')).toBe('human-gated');
    expect(readHistory(reg, 'dep-a').some((h) => authKind(h) === 'earn-in-policy')).toBe(false);
  });
});

// ==========================================================================
// Group G (store half) — release-ledger debut readers (PGlite / real store).
// ==========================================================================

interface AppendEvent {
  releaseId: string;
  deployment: string;
  event: 'proposal' | 'decision' | 'attempt' | 'execution' | 'completion' | 'resolved';
  targetRevision?: string | null;
  detail?: Record<string, unknown>;
  at?: string;
}
interface LedgerReaderLike {
  eventsForRelease: (d: string, r: string) => Promise<unknown[]>;
}
interface LedgerWriterLike {
  append: (e: AppendEvent) => Promise<void>;
  reader: () => LedgerReaderLike;
  close?: () => Promise<void>;
}
type MakeTempLedger = () => Promise<{ writer: LedgerWriterLike; cleanup: () => Promise<void> }>;

async function openLedger(): Promise<LedgerWriterLike> {
  const p: string = '../../../release-ledger/test/helpers/temp-db.js';
  let record: Record<string, unknown> = {};
  try {
    record = (await import(p)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`gate: release-ledger PGlite helper (${p}) must exist and export makeTempLedger — ${(err as Error).message}`);
  }
  const make = record['makeTempLedger'];
  expect(make, 'gate: makeTempLedger must be exported by the release-ledger PGlite helper').toBeTypeOf('function');
  const { writer, cleanup } = await (make as MakeTempLedger)();
  cleanups.push(cleanup);
  return writer;
}

describe('gate G — release-ledger debut readers over decision events (real store)', () => {
  it('22/23 — hasPriorApprovedRelease / hasDebutAuthorization derive from approve / approve-with-debut decision events', async () => {
    const w = await openLedger();
    const reader = w.reader();
    const hasPrior = (reader as unknown as { hasPriorApprovedRelease?: (d: string) => Promise<boolean> }).hasPriorApprovedRelease;
    const hasDebut = (reader as unknown as { hasDebutAuthorization?: (d: string) => Promise<boolean> }).hasDebutAuthorization;
    expect(hasPrior, 'gate: ReleaseLedgerReader.hasPriorApprovedRelease (Task 7) must exist').toBeTypeOf('function');
    expect(hasDebut, 'gate: ReleaseLedgerReader.hasDebutAuthorization (Task 7) must exist').toBeTypeOf('function');

    await w.append({ releaseId: 'r1', deployment: 'd-reject', event: 'decision', targetRevision: null, detail: { answer: 'reject' } });
    expect(await hasPrior!.call(reader, 'd-reject')).toBe(false);
    expect(await hasDebut!.call(reader, 'd-reject')).toBe(false);

    await w.append({ releaseId: 'r2', deployment: 'd-approve', event: 'decision', targetRevision: null, detail: { answer: 'approve' } });
    expect(await hasPrior!.call(reader, 'd-approve')).toBe(true);
    expect(await hasDebut!.call(reader, 'd-approve')).toBe(false);

    await w.append({ releaseId: 'r3', deployment: 'd-debut', event: 'decision', targetRevision: null, detail: { answer: 'approve-with-debut', debutAuthorized: true } });
    expect(await hasPrior!.call(reader, 'd-debut')).toBe(true);
    expect(await hasDebut!.call(reader, 'd-debut')).toBe(true);

    expect(await hasPrior!.call(reader, 'd-none')).toBe(false);
    expect(await hasDebut!.call(reader, 'd-none')).toBe(false);
  });
});

// ==========================================================================
// Group J (executor half) — the executor records debutAuthorized for the
// approve-with-debut answer and still drives the declared release path.
// In-memory fake Release Ledger (mirrors the P5 release-lane gate harness).
// ==========================================================================

interface FakeRow {
  id: number;
  releaseId: string;
  deployment: string;
  event: 'proposal' | 'decision' | 'attempt' | 'execution' | 'completion' | 'resolved';
  targetRevision: string | null;
  detail: Record<string, unknown>;
  at: string;
}

function makeFakeLedger() {
  const events: FakeRow[] = [];
  let nextId = 1;
  const seed = (e: Partial<FakeRow> & Pick<FakeRow, 'releaseId' | 'deployment' | 'event'>): void => {
    events.push({ id: nextId++, at: new Date(NOW).toISOString(), targetRevision: null, detail: {}, ...e });
  };
  const reader = {
    eventsForRelease: vi.fn(async (deployment: string, releaseId: string) =>
      events.filter((r) => r.deployment === deployment && r.releaseId === releaseId).sort((a, b) => a.id - b.id),
    ),
    lastReleasedMarker: vi.fn(async (deployment: string) => {
      const rows = events
        .filter((r) => r.deployment === deployment && (r.event === 'execution' || r.event === 'completion'))
        .sort((a, b) => b.id - a.id);
      for (const r of rows) if ((r.detail as { outcome?: string }).outcome === 'released') return r.targetRevision ?? undefined;
      return undefined;
    }),
    latestOutcome: vi.fn(async (deployment: string, releaseId: string) => {
      const rows = events
        .filter((r) => r.deployment === deployment && r.releaseId === releaseId && (r.event === 'execution' || r.event === 'completion'))
        .sort((a, b) => b.id - a.id);
      return rows[0] ? (rows[0].detail as { outcome?: string }).outcome : undefined;
    }),
    openReleases: vi.fn(async () => {
      const byRel = new Map<string, FakeRow[]>();
      for (const r of events) {
        const arr = byRel.get(r.releaseId) ?? [];
        arr.push(r);
        byRel.set(r.releaseId, arr);
      }
      const out: { deployment: string; releaseId: string; detail: Record<string, unknown> }[] = [];
      for (const [releaseId, rows] of byRel) {
        const proposal = rows.find((r) => r.event === 'proposal');
        const resolved = rows.some((r) => r.event === 'resolved');
        if (proposal && !resolved) out.push({ deployment: proposal.deployment, releaseId, detail: proposal.detail });
      }
      return out;
    }),
  };
  const writer = {
    append: vi.fn(async (e: Partial<FakeRow> & Pick<FakeRow, 'releaseId' | 'deployment' | 'event'>) => { seed(e); }),
    appendProposalIfAbsent: vi.fn(async (e: Partial<FakeRow> & Pick<FakeRow, 'releaseId' | 'deployment' | 'event'>) => {
      if (events.some((r) => r.releaseId === e.releaseId && r.event === 'proposal')) return false;
      seed(e);
      return true;
    }),
    reader: () => reader,
    close: vi.fn(async () => {}),
  };
  return { writer, reader, events, seed };
}

function makeFakeDecisionManager() {
  const ledger = {
    raise: vi.fn(async (req: { decision_id?: string }) => ({ decision_id: req.decision_id })),
    notify: vi.fn(async (_id: string) => {}),
    answer: vi.fn(async (_id: string, _ans: string, _actor: string) => {}),
    advanceToResumed: vi.fn(async (_id: string) => {}),
    statusOf: vi.fn(async (_id: string) => 'raised'),
  };
  return {
    markRuntimeDegraded: vi.fn((_reason: string) => {}),
    clearRuntimeDegraded: vi.fn(() => {}),
    autonomyLevel: 'auto-merge' as const,
    ledger: () => ledger,
    _ledger: ledger,
  };
}

function makePromotion() {
  return {
    promote: vi.fn(async (_a: unknown) => {}),
    rollback: vi.fn(async (_a: unknown) => {}),
    fireTrigger: vi.fn(async (_a: unknown) => {}),
  };
}

const DEPLOY = 'acme/widgets';

function seedProposalEvent(ledger: ReturnType<typeof makeFakeLedger>, releaseId: string, targetRevision: string, declaredPath: unknown): void {
  ledger.seed({
    releaseId,
    deployment: DEPLOY,
    event: 'proposal',
    targetRevision,
    detail: {
      deployment: DEPLOY,
      targetRevision,
      sinceRevision: 'prev0000',
      coveredWork: [{ sha: 'c1', subject: 'add feature', issueNumbers: [12] }],
      declaredPath,
      summary: 'Release acme/widgets',
      issueNumber: 4242,
    },
  });
}

function makeReleaseDeps(ledger: ReturnType<typeof makeFakeLedger>, answer: string) {
  return {
    registry: {
      readDeclaredData: (_id: string, _which: 'landing') => ({ kind: 'found', value: { landsOn: 'main', productionReleasePath: { kind: 'platform-performs' } } }),
    },
    repositoriesFor: (_d: string) => [{ owner: 'acme', name: 'widgets' }],
    ledger: ledger.writer,
    trunkReader: {
      getTrunkHead: vi.fn(async () => ({ sha: 'sha-head' })),
      compareSince: vi.fn(async () => ({ commits: [] })),
      listRecent: vi.fn(async () => ({ commits: [] })),
    },
    promotion: makePromotion(),
    decisionManager: makeFakeDecisionManager(),
    publisher: { ensure: vi.fn(async (_a: unknown) => ({ posted: true })) },
    sanitize: vi.fn(async (req: unknown) => req),
    readAnswer: vi.fn(async (_d: string, _id: string, _issue: number) => answer),
    octokit: {} as unknown,
    issueNumberFor: (_d: string) => 4242,
  };
}

interface ExecutorLane {
  resolveRelease: (deployment: string, releaseId: string) => Promise<{ kind: string; outcome?: string }>;
}

describe('gate J — the executor records debutAuthorized for an approve-with-debut answer', () => {
  it('30 — resolving an approve-with-debut release records decision.detail.debutAuthorized:true and still releases', async () => {
    const createReleaseLane = await loadExport<(deps: unknown) => ExecutorLane>('./release/executor.js', 'createReleaseLane');
    const ledger = makeFakeLedger();
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    const lane = createReleaseLane(makeReleaseDeps(ledger, 'approve-with-debut'));

    const res = await lane.resolveRelease(DEPLOY, releaseId);
    // approve-with-debut drives the declared release path identically to approve.
    expect(res.outcome).toBe('released');
    // The net-new recording: the decision event carries the debut authorization flag.
    const decision = ledger.events.find((r) => r.event === 'decision');
    expect(decision, 'a decision event was appended').toBeDefined();
    expect(decision?.detail, 'gate: decision.detail.debutAuthorized must be true for approve-with-debut').toMatchObject({ debutAuthorized: true });
  });
});
