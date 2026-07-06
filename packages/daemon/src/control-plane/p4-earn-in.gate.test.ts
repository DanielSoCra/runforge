// P4.2 pre-approved earn-in IMMOVABLE acceptance gate — PURE (no-DB, no external
// state) criteria. Groups A, B, C, D(9/10), E, G(20/21), H, J(28/28b/28c/28d/28e),
// K(31).
//
// Authored RED against HEAD: the earn-in node
// (`control-plane/earn-in/{floors,promotion-policy,track-record,mint,debut,
// demote-on-red}.ts`), the `releaseAnswerFromParsed` mapping helper, the
// `createReleaseReadAnswer` factory, and the `offerDebut` builder option do not
// exist yet, and `parseCockpitAnswer` does not yet recognize `approve-with-debut`.
// Every not-yet-existing symbol is reached through a runtime dynamic `import()`
// with the specifier widened to `string` so tsc never resolves it (no TS2307, no
// suppression directives) and vitest can COLLECT the file; the missing export is
// then converted to a clean failing assertion inside each async test — never a
// collection/transform crash. The suite goes GREEN only when Tasks 1–10 land.
//
// Source of truth: docs/superpowers/plans/2026-07-03-p4-earn-in.md
// §"Immovable Acceptance-Gate SPEC" (groups A–K). L2 ARCH-AC-EARN-IN, L3
// STACK-AC-EARN-IN.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCockpitAnswer,
  type CockpitAnswer,
} from './decision-escalation/resume-consumer.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------
// Runtime-lookup loaders. `modulePath: string` (widened) keeps tsc from
// resolving a not-yet-existing specifier; a missing module/symbol becomes a
// clean per-test assertion failure (the RED reason), not a collection error.
// --------------------------------------------------------------------------

async function loadModule(modulePath: string): Promise<Record<string, unknown>> {
  try {
    return (await import(modulePath)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `gate: module ${modulePath} must exist — ${(err as Error).message}`,
    );
  }
}

async function loadExport<T>(modulePath: string, name: string): Promise<T> {
  const record = await loadModule(modulePath);
  const exported = record[name];
  expect(exported, `gate: ${name} must be exported by ${modulePath}`).toBeTypeOf(
    'function',
  );
  return exported as T;
}

async function loadConst<T>(modulePath: string, name: string): Promise<T> {
  const record = await loadModule(modulePath);
  const exported = record[name];
  expect(exported, `gate: ${name} must be exported by ${modulePath}`).toBeDefined();
  return exported as T;
}

// --------------------------------------------------------------------------
// Loaded-symbol signatures (precise enough that the calls typecheck).
// --------------------------------------------------------------------------

type RiskLevel = 'green' | 'yellow' | 'orange' | 'red';

type FloorName =
  | 'bar-clean-merges-below-floor'
  | 'bar-recency-below-floor'
  | 'insufficient-recent-clean-merges'
  | 'red-in-window'
  | 'scope-not-holding'
  | 'verifier-not-gated'
  | 'reversible';

interface EarnInFloors {
  minCleanMerges: number;
  recencyWindowDays: number;
  redWindowDays: number;
}
interface LaneTrackRecord {
  cleanMerges: number;
  bounceFreeDays: number;
}
type EarnInPolicy = LaneTrackRecord;

interface PromotionTrackRecord {
  bar: LaneTrackRecord;
  cleanMergesInWindow: number;
  redEventInWindow: boolean;
}

type PromotionResult =
  | { kind: 'not-eligible' }
  | { kind: 'raise-decision'; failedFloors: FloorName[] }
  | {
      kind: 'auto-widen';
      clearedFloors: FloorName[];
      evidence: PromotionTrackRecord;
      policyRef: string;
    };

interface PromotionInput {
  record: PromotionTrackRecord;
  bar: EarnInPolicy | undefined;
  preApproved?: { enabled: boolean; policyRef: string };
  verifierFalsifying: boolean;
  scopeHolding: boolean;
}

type EvaluatePromotion = (i: PromotionInput) => PromotionResult;
type FloorsFailed = (i: PromotionInput) => FloorName[];

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

interface MintInput {
  promotion: PromotionResult;
  effectiveRisk: RiskLevel;
  verifierFalsifying: boolean;
  complianceForced: boolean;
  currentlyHumanGated: boolean;
  isDebut: boolean;
  hasDebutAuthorization: boolean;
}
type MintPlan =
  | { kind: 'mint'; level: RiskLevel; policyRef: string; clearedFloors: string[]; evidence: unknown }
  | { kind: 'withhold-debut' }
  | { kind: 'skip' };
type PlanMint = (i: MintInput) => MintPlan;

type IsDebut = (history: WideningRecordLike[]) => boolean;
type IsRedEvent = (status: 'healthy' | 'red' | 'indeterminate') => boolean;

interface DecisionRequestLike {
  options: { id: string; label: string }[];
  answer_schema: { kind: string };
}
interface ReleaseProposalLike {
  deployment: string;
  targetRevision: string;
  sinceRevision: string | undefined;
  coveredWork: { sha: string; subject: string; issueNumbers: number[] }[];
  declaredPath: { kind: string };
  summary: string;
}
type BuildReleaseDecisionRequest = (
  proposal: ReleaseProposalLike,
  opts?: { now?: string; offerDebut?: boolean },
) => DecisionRequestLike;

type ReleaseAnswerFromParsed = (
  parsed: { choice: 'approve' | 'reject'; rawChosenOption: string } | undefined,
) => 'approve' | 'reject' | 'approve-with-debut' | undefined;

type CreateReleaseReadAnswer = (deps: {
  octokit: unknown;
  repositoriesFor: (d: string) => { owner: string; name: string }[];
}) => (
  deployment: string,
  decisionId: string,
  issueNumber: number,
) => Promise<'approve' | 'reject' | 'approve-with-debut' | undefined>;

// --------------------------------------------------------------------------
// Shared fixtures.
// --------------------------------------------------------------------------

const EARN_IN = './earn-in';
const FLOORS: EarnInFloors = { minCleanMerges: 10, recencyWindowDays: 30, redWindowDays: 30 };
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 3); // 2026-07-03
const isoDaysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();

function strongRecord(): PromotionTrackRecord {
  return { bar: { cleanMerges: 12, bounceFreeDays: 40 }, cleanMergesInWindow: 12, redEventInWindow: false };
}
function strongBar(): EarnInPolicy {
  return { cleanMerges: 10, bounceFreeDays: 30 };
}
function baseInput(over: Partial<PromotionInput> = {}): PromotionInput {
  return {
    record: strongRecord(),
    bar: strongBar(),
    preApproved: { enabled: true, policyRef: 'ops-pack-v1' },
    verifierFalsifying: true,
    scopeHolding: true,
    ...over,
  };
}
function autoWiden(over: Partial<Extract<PromotionResult, { kind: 'auto-widen' }>> = {}): PromotionResult {
  return {
    kind: 'auto-widen',
    clearedFloors: [
      'bar-clean-merges-below-floor',
      'bar-recency-below-floor',
      'insufficient-recent-clean-merges',
      'red-in-window',
      'scope-not-holding',
      'verifier-not-gated',
      'reversible',
    ],
    evidence: strongRecord(),
    policyRef: 'ops-pack-v1',
    ...over,
  };
}
function mintInput(over: Partial<MintInput> = {}): MintInput {
  return {
    promotion: autoWiden(),
    effectiveRisk: 'green',
    verifierFalsifying: true,
    complianceForced: false,
    currentlyHumanGated: true,
    isDebut: false,
    hasDebutAuthorization: false,
    ...over,
  };
}

const builderProposal: ReleaseProposalLike = {
  deployment: 'acme/widgets',
  targetRevision: 'abc123456789',
  sinceRevision: 'prev0000',
  coveredWork: [{ sha: 'c1', subject: 'add feature', issueNumbers: [12, 14] }],
  declaredPath: { kind: 'platform-performs' },
  summary: 'Release acme/widgets',
};

// A byte-faithful pm-cockpit DecisionResponse comment: the `**DecisionResponse**`
// tag, the AUTHORITATIVE effect marker binding `<decisionId>:write_response`, and a
// MINIMAL fenced-JSON `{ chosen_option }` payload — exactly what the live cockpit
// writer emits and `parseCockpitAnswer` keys on (resume-consumer.ts:82-165).
function cockpitComment(decisionId: string, chosenOption: string): { body: string } {
  return {
    body: [
      '**DecisionResponse**',
      `<!-- pm-cockpit:effect:${decisionId}:write_response:k1:etag=abc123 -->`,
      '```json',
      JSON.stringify({ chosen_option: chosenOption }),
      '```',
    ].join('\n'),
  };
}

// ==========================================================================
// Group A — auto-widen ONLY when ALL conditions hold (evaluatePromotion).
// ==========================================================================

describe('gate A — auto-widen only when bar met + preApproved enabled + all floors clear', () => {
  it('A1 — bar not met → not-eligible (never raise-decision, never auto-widen)', async () => {
    const evaluatePromotion = await loadExport<EvaluatePromotion>(`${EARN_IN}/promotion-policy.js`, 'evaluatePromotion');
    const res = evaluatePromotion(
      baseInput({ record: { bar: { cleanMerges: 5, bounceFreeDays: 40 }, cleanMergesInWindow: 5, redEventInWindow: false } }),
    );
    expect(res.kind).toBe('not-eligible');
  });

  it('A2 — bar met + preApproved enabled + all floors clear → auto-widen carrying policyRef and clearedFloors === FLOOR_NAMES', async () => {
    const evaluatePromotion = await loadExport<EvaluatePromotion>(`${EARN_IN}/promotion-policy.js`, 'evaluatePromotion');
    const FLOOR_NAMES = await loadConst<readonly FloorName[]>(`${EARN_IN}/floors.js`, 'FLOOR_NAMES');
    const res = evaluatePromotion(baseInput());
    expect(res.kind).toBe('auto-widen');
    if (res.kind === 'auto-widen') {
      expect(res.policyRef).toBe('ops-pack-v1');
      expect(new Set(res.clearedFloors)).toEqual(new Set(FLOOR_NAMES));
      expect(res.clearedFloors).toHaveLength(FLOOR_NAMES.length);
    }
  });

  it('A3 — bar met + preApproved ABSENT → raise-decision (v2 default), never auto-widen', async () => {
    const evaluatePromotion = await loadExport<EvaluatePromotion>(`${EARN_IN}/promotion-policy.js`, 'evaluatePromotion');
    const res = evaluatePromotion(baseInput({ preApproved: undefined }));
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') expect(res.failedFloors).toEqual([]);
  });

  it('A3b — bar met + preApproved present but enabled:false → raise-decision (inert), never auto-widen', async () => {
    const evaluatePromotion = await loadExport<EvaluatePromotion>(`${EARN_IN}/promotion-policy.js`, 'evaluatePromotion');
    const res = evaluatePromotion(baseInput({ preApproved: { enabled: false, policyRef: 'x' } }));
    expect(res.kind).toBe('raise-decision');
  });

  it('A4 — property: auto-widen iff preApproved present AND enabled AND no failed floors', async () => {
    const evaluatePromotion = await loadExport<EvaluatePromotion>(`${EARN_IN}/promotion-policy.js`, 'evaluatePromotion');
    const preApprovedVariants: ({ enabled: boolean; policyRef: string } | undefined)[] = [
      undefined,
      { enabled: false, policyRef: 'x' },
      { enabled: true, policyRef: 'ops-pack-v1' },
    ];
    const floorVariants: { label: string; over: Partial<PromotionInput> }[] = [
      { label: 'clear', over: {} },
      { label: 'scope-broken', over: { scopeHolding: false } },
      { label: 'verifier-broken', over: { verifierFalsifying: false } },
    ];
    for (const preApproved of preApprovedVariants) {
      for (const fv of floorVariants) {
        const res = evaluatePromotion(baseInput({ preApproved, ...fv.over }));
        const shouldWiden = preApproved?.enabled === true && fv.label === 'clear';
        const tag = `${JSON.stringify(preApproved)}/${fv.label}`;
        if (shouldWiden) expect(res.kind, tag).toBe('auto-widen');
        else expect(res.kind, tag).not.toBe('auto-widen');
      }
    }
  });
});

// ==========================================================================
// Group B — a missing bar and a bar below a floor both fail closed.
// ==========================================================================

describe('gate B — missing bar → not-eligible; weak bar → raise-decision; both never auto-widen', () => {
  it('B5 — missing bar (undefined) + record strong + preApproved enabled → not-eligible (distinct tag, fail closed)', async () => {
    const evaluatePromotion = await loadExport<EvaluatePromotion>(`${EARN_IN}/promotion-policy.js`, 'evaluatePromotion');
    const res = evaluatePromotion(baseInput({ bar: undefined }));
    expect(res.kind).toBe('not-eligible');
    expect(res.kind).not.toBe('auto-widen');
  });

  it('B5b — weak bar (cleanMerges 3 < floor 10) → raise-decision with bar-clean-merges-below-floor, never auto-widen', async () => {
    const evaluatePromotion = await loadExport<EvaluatePromotion>(`${EARN_IN}/promotion-policy.js`, 'evaluatePromotion');
    const res = evaluatePromotion(baseInput({ bar: { cleanMerges: 3, bounceFreeDays: 40 } }));
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') expect(res.failedFloors).toContain('bar-clean-merges-below-floor');
  });

  it('B6 — weak bar recency (bounceFreeDays 5 < floor 30) → raise-decision with bar-recency-below-floor', async () => {
    const evaluatePromotion = await loadExport<EvaluatePromotion>(`${EARN_IN}/promotion-policy.js`, 'evaluatePromotion');
    const res = evaluatePromotion(baseInput({ bar: { cleanMerges: 12, bounceFreeDays: 5 } }));
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') expect(res.failedFloors).toContain('bar-recency-below-floor');
  });
});

// ==========================================================================
// Group C — recency requires the FULL count in window (derivePromotionTrackRecord).
// ==========================================================================

describe('gate C — recency is the full in-window count, not most-recent-within-window', () => {
  it('C7 — dormant lane (10 clean 100d old + 1 fresh) → cleanMergesInWindow===1, bar.cleanMerges===11; evaluatePromotion → insufficient-recent-clean-merges', async () => {
    const derive = await loadExport<DerivePromotionTrackRecord>(`${EARN_IN}/track-record.js`, 'derivePromotionTrackRecord');
    const evaluatePromotion = await loadExport<EvaluatePromotion>(`${EARN_IN}/promotion-policy.js`, 'evaluatePromotion');
    const outcomes: LaneOutcome[] = [
      ...Array.from({ length: 10 }, (): LaneOutcome => ({ ts: isoDaysAgo(100), deploymentId: 'dep-a', lane: 'fast', kind: 'clean-merge' })),
      { ts: isoDaysAgo(1), deploymentId: 'dep-a', lane: 'fast', kind: 'clean-merge' },
    ];
    const record = derive(outcomes, [], NOW, FLOORS);
    expect(record.cleanMergesInWindow).toBe(1); // NOT 11
    expect(record.bar.cleanMerges).toBe(11);
    const res = evaluatePromotion({ record, bar: strongBar(), preApproved: { enabled: true, policyRef: 'p' }, verifierFalsifying: true, scopeHolding: true });
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') expect(res.failedFloors).toContain('insufficient-recent-clean-merges');
  });

  it('C8 — 10 clean merges all within 30d → cleanMergesInWindow===10; recency floor clears', async () => {
    const derive = await loadExport<DerivePromotionTrackRecord>(`${EARN_IN}/track-record.js`, 'derivePromotionTrackRecord');
    const floorsFailed = await loadExport<FloorsFailed>(`${EARN_IN}/promotion-policy.js`, 'floorsFailed');
    const outcomes: LaneOutcome[] = Array.from({ length: 10 }, (_v, i): LaneOutcome => ({
      ts: isoDaysAgo(i * 2), deploymentId: 'dep-a', lane: 'fast', kind: 'clean-merge',
    }));
    const record = derive(outcomes, [], NOW, FLOORS);
    expect(record.cleanMergesInWindow).toBe(10);
    const failed = floorsFailed({ record, bar: strongBar(), preApproved: { enabled: true, policyRef: 'p' }, verifierFalsifying: true, scopeHolding: true });
    expect(failed).not.toContain('insufficient-recent-clean-merges');
  });
});

// ==========================================================================
// Group D (pure half) — red-in-window derivation from outcomes and history.
// ==========================================================================

describe('gate D — red-in-window blocks and is set by a red outcome OR a demote record', () => {
  it('D9 — red outcome now-5d → redEventInWindow true; now-40d → false', async () => {
    const derive = await loadExport<DerivePromotionTrackRecord>(`${EARN_IN}/track-record.js`, 'derivePromotionTrackRecord');
    const fresh = derive([{ ts: isoDaysAgo(5), deploymentId: 'dep-a', lane: 'fast', kind: 'red', redReason: 'failed-release' }], [], NOW, FLOORS);
    expect(fresh.redEventInWindow).toBe(true);
    const stale = derive([{ ts: isoDaysAgo(40), deploymentId: 'dep-a', lane: 'fast', kind: 'red', redReason: 'failed-release' }], [], NOW, FLOORS);
    expect(stale.redEventInWindow).toBe(false);
  });

  it('D10 — demote WideningRecord (next human-gated, recordedAt now-5d) with NO red outcome → redEventInWindow true', async () => {
    const derive = await loadExport<DerivePromotionTrackRecord>(`${EARN_IN}/track-record.js`, 'derivePromotionTrackRecord');
    const history: WideningRecordLike[] = [
      { deploymentId: 'dep-a', riskClass: 'green', prior: 'widened', next: 'human-gated', authorization: { kind: 'demote-on-red', trigger: 'red-trunk' }, recordedAt: NOW - 5 * DAY },
    ];
    const record = derive([], history, NOW, FLOORS);
    expect(record.redEventInWindow).toBe(true);
  });
});

// ==========================================================================
// Group E — planMint idempotent + never touches always-escalate.
// ==========================================================================

describe('gate E — the mint is idempotent and never crosses an always-escalate boundary', () => {
  it('E12 — auto-widen + currentlyHumanGated:false → skip (idempotent second pass)', async () => {
    const planMint = await loadExport<PlanMint>(`${EARN_IN}/mint.js`, 'planMint');
    expect(planMint(mintInput({ currentlyHumanGated: false })).kind).toBe('skip');
  });

  it('E13 — auto-widen + effectiveRisk orange|red → skip', async () => {
    const planMint = await loadExport<PlanMint>(`${EARN_IN}/mint.js`, 'planMint');
    expect(planMint(mintInput({ effectiveRisk: 'orange' })).kind).toBe('skip');
    expect(planMint(mintInput({ effectiveRisk: 'red' })).kind).toBe('skip');
  });

  it('E14 — auto-widen + complianceForced:true → skip', async () => {
    const planMint = await loadExport<PlanMint>(`${EARN_IN}/mint.js`, 'planMint');
    expect(planMint(mintInput({ complianceForced: true })).kind).toBe('skip');
  });

  it('E15 — auto-widen + verifierFalsifying:false → skip', async () => {
    const planMint = await loadExport<PlanMint>(`${EARN_IN}/mint.js`, 'planMint');
    expect(planMint(mintInput({ verifierFalsifying: false })).kind).toBe('skip');
  });

  it('E16 — auto-widen + all guards clear + not-debut → mint carrying level and policyRef', async () => {
    const planMint = await loadExport<PlanMint>(`${EARN_IN}/mint.js`, 'planMint');
    const plan = planMint(mintInput());
    expect(plan.kind).toBe('mint');
    if (plan.kind === 'mint') {
      expect(plan.level).toBe('green');
      expect(plan.policyRef).toBe('ops-pack-v1');
    }
  });

  it('E-raise — a raise-decision evaluation → skip (mints nothing)', async () => {
    const planMint = await loadExport<PlanMint>(`${EARN_IN}/mint.js`, 'planMint');
    expect(planMint(mintInput({ promotion: { kind: 'raise-decision', failedFloors: ['red-in-window'] } })).kind).toBe('skip');
  });
});

// ==========================================================================
// Group G (pure half) — isDebut derivation + the debut arm of planMint.
// ==========================================================================

describe('gate G — the debut withholds the first-ever widening but not after any prior widening', () => {
  it('G20 — isDebut([])→true; prior operator-grant widened→false; only a demote→true', async () => {
    const isDebut = await loadExport<IsDebut>(`${EARN_IN}/debut.js`, 'isDebut');
    expect(isDebut([])).toBe(true);
    expect(
      isDebut([{ deploymentId: 'd', riskClass: 'green', prior: 'human-gated', next: 'widened', authorization: { kind: 'operator-grant', operator: 'daniel' }, recordedAt: NOW }]),
    ).toBe(false);
    expect(
      isDebut([{ deploymentId: 'd', riskClass: 'green', prior: 'widened', next: 'human-gated', authorization: { kind: 'demote-on-red', trigger: 'red' }, recordedAt: NOW }]),
    ).toBe(true);
  });

  it('G21 — planMint isDebut:true + hasDebutAuthorization:false → withhold-debut; isDebut:false → mint regardless of authorization', async () => {
    const planMint = await loadExport<PlanMint>(`${EARN_IN}/mint.js`, 'planMint');
    expect(planMint(mintInput({ isDebut: true, hasDebutAuthorization: false })).kind).toBe('withhold-debut');
    expect(planMint(mintInput({ isDebut: false, hasDebutAuthorization: false })).kind).toBe('mint');
  });
});

// ==========================================================================
// Group H — no-release-path fails closed to per-event but is never trapped.
// ==========================================================================

describe('gate H — no-release-path withholds the debut but is not permanently closed', () => {
  it('H24 — isDebut:true + hasDebutAuthorization:false → withhold-debut (merges keep reaching the Operator)', async () => {
    const planMint = await loadExport<PlanMint>(`${EARN_IN}/mint.js`, 'planMint');
    expect(planMint(mintInput({ isDebut: true, hasDebutAuthorization: false })).kind).toBe('withhold-debut');
  });

  it('H25 — after ANY widened record (e.g. an operator-grant), isDebut→false so planMint mints on the next clear evaluation', async () => {
    const isDebut = await loadExport<IsDebut>(`${EARN_IN}/debut.js`, 'isDebut');
    const planMint = await loadExport<PlanMint>(`${EARN_IN}/mint.js`, 'planMint');
    const historyAfterOperatorGrant: WideningRecordLike[] = [
      { deploymentId: 'dep-a', riskClass: 'green', prior: 'human-gated', next: 'widened', authorization: { kind: 'operator-grant', operator: 'daniel' }, recordedAt: NOW },
    ];
    const debut = isDebut(historyAfterOperatorGrant);
    expect(debut).toBe(false);
    expect(planMint(mintInput({ isDebut: debut, hasDebutAuthorization: false })).kind).toBe('mint');
  });
});

// ==========================================================================
// Group J (pure live-seam half) — release amendment: builder option, live
// parser, mapping helper, factory, daemon-wiring static guard.
// ==========================================================================

describe('gate J — the approve-with-debut live seam (parser → mapping → factory → daemon wiring)', () => {
  it('28 — buildReleaseDecisionRequest(offerDebut:true) → three options incl. approve-with-debut; falsy → two', async () => {
    const build = await loadExport<BuildReleaseDecisionRequest>('./release/build-request.js', 'buildReleaseDecisionRequest');
    const two = build(builderProposal, { now: '2026-07-03T00:00:00.000Z' });
    expect(two.options.map((o) => o.id).sort()).toEqual(['approve', 'reject']); // control: HEAD shape
    const three = build(builderProposal, { now: '2026-07-03T00:00:00.000Z', offerDebut: true });
    expect(three.answer_schema.kind).toBe('option');
    expect(three.options.map((o) => o.id).sort()).toEqual(['approve', 'approve-with-debut', 'reject']);
  });

  it('28b — parseCockpitAnswer recognizes approve-with-debut → {choice:approve, rawChosenOption:approve-with-debut}', () => {
    const DID = 'release:acme/widgets:abc12345';
    // Control: a plain approve is recognized at HEAD → proves the marker/harness is valid.
    const control: CockpitAnswer | null = parseCockpitAnswer([cockpitComment(DID, 'approve')], DID);
    expect(control?.rawChosenOption, 'harness precondition: plain approve is parseable').toBe('approve');
    // The net-new behavior: the third option id must be recognized live.
    const debut: CockpitAnswer | null = parseCockpitAnswer([cockpitComment(DID, 'approve-with-debut')], DID);
    expect(debut?.choice).toBe('approve');
    expect(debut?.rawChosenOption).toBe('approve-with-debut');
  });

  it('28c — releaseAnswerFromParsed maps rawChosenOption to the widened union', async () => {
    const map = await loadExport<ReleaseAnswerFromParsed>('./decision-escalation/resume-consumer.js', 'releaseAnswerFromParsed');
    expect(map({ choice: 'approve', rawChosenOption: 'approve-with-debut' })).toBe('approve-with-debut');
    expect(map({ choice: 'approve', rawChosenOption: 'approve' })).toBe('approve');
    expect(map(undefined)).toBeUndefined();
  });

  it('28d — createReleaseReadAnswer factory (fetch → parse → map) returns approve-with-debut end-to-end', async () => {
    const createReleaseReadAnswer = await loadExport<CreateReleaseReadAnswer>('./release/read-answer.js', 'createReleaseReadAnswer');
    const DID = 'release:acme/widgets:abc12345';
    const repositoriesFor = (_d: string) => [{ owner: 'acme', name: 'widgets' }];
    const octokitFor = (chosen: string) => ({
      issues: { listComments: async (_a: unknown) => ({ data: [cockpitComment(DID, chosen)] }) },
    });
    const debutReader = createReleaseReadAnswer({ octokit: octokitFor('approve-with-debut'), repositoriesFor });
    expect(await debutReader('acme/widgets', DID, 42)).toBe('approve-with-debut');
    const plainReader = createReleaseReadAnswer({ octokit: octokitFor('approve'), repositoriesFor });
    expect(await plainReader('acme/widgets', DID, 42)).toBe('approve');
  });

  it('28e — daemon.ts wires its release readAnswer via createReleaseReadAnswer, with the mapping ONLY in release/read-answer.ts', () => {
    expect(existsSync(join(HERE, 'release/read-answer.ts')), 'gate: release/read-answer.ts must exist').toBe(true);
    const daemonSrc = readFileSync(join(HERE, 'daemon.ts'), 'utf8');
    expect(daemonSrc.includes('createReleaseReadAnswer('), 'gate: daemon.ts must construct readAnswer via createReleaseReadAnswer').toBe(true);
    // Anti-false-green: the old inline `.choice` release closure must be gone.
    expect(
      daemonSrc.includes('parseCockpitAnswer(comments, decisionId)?.choice'),
      'gate: the inline release-answer `.choice` closure must be removed from daemon.ts',
    ).toBe(false);
  });
});

// ==========================================================================
// Group K — decideMerge stays pure and untouched (static, with earn-in existing).
// ==========================================================================

describe('gate K — decideMerge stays untouched: earn-in exists as a sibling decide.ts never imports', () => {
  it('31 — the earn-in barrel exports evaluatePromotion AND merge-decision/decide.ts imports no earn-in symbol', async () => {
    // Positive half (RED at HEAD: the barrel does not exist yet).
    await loadExport<EvaluatePromotion>(`${EARN_IN}/index.js`, 'evaluatePromotion');
    // Preservation invariant: decide.ts must never reach into earn-in.
    const decideSrc = readFileSync(join(HERE, 'merge-decision/decide.ts'), 'utf8');
    expect(/from\s+['"][^'"]*earn-in/.test(decideSrc), 'gate: decide.ts must not import from earn-in/').toBe(false);
    for (const symbol of ['evaluatePromotion', 'derivePromotionTrackRecord', 'planMint', 'recordWidening']) {
      expect(decideSrc.includes(symbol), `gate: decide.ts must not reference ${symbol}`).toBe(false);
    }
  });
});
