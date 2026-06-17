// packages/daemon/src/control-plane/merge-decision/decide.test.ts
//
// IMMOVABLE acceptance contract for the pure merge-decision core (slice 5a).
// One test per precedence arm (first-match-wins, fail-safe) plus the
// safe-by-default invariants. The bodies under test are stubs that throw
// 'not implemented' — these tests are RED until Kimi fills decideMerge.
//
// Where the plan leaves a representational choice, we assert BEHAVIOUR (the
// decision kind + reason + populated fields), never internals.
import { describe, it, expect } from 'vitest';
import { decideMerge } from './decide.js';
import type { MergeDecisionInput } from './types.js';
import type {
  ClassifierVerdict,
  LaneDefinition,
  LaneSet,
  RiskLevel,
  RiskPathMap,
} from '../lane-engine/types.js';
import type { VerifierDeclaration, VerifierStatus } from '../lane-engine/verifier-gate/types.js';

// ---- fixtures -------------------------------------------------------------

const verifier: VerifierDeclaration = {
  kind: 'test-suite',
  invoke: { ref: 'pnpm --filter @auto-claude/daemon test' },
};

/** A verifier observed runnable + falsifying — the ONLY status that gates. */
const GOOD_STATUS: VerifierStatus = { observed: true, runnable: true, falsifying: true };
/** Observed but not falsifying — withholds autonomy. */
const WEAK_STATUS: VerifierStatus = { observed: true, runnable: true, falsifying: false };

/**
 * Two non-overlapping lanes:
 *  - `auto`: qualifies on a 'simple' verdict, allows only docs/feature paths,
 *    declares a verifier, requests `auto`.
 *  - `cautious`: the most-cautious fallback, qualifies on 'complex', also
 *    declares a verifier (so the fallback arm is reached AFTER the verifier
 *    gate passes), requests `hold`.
 */
function makeLaneSet(over: { autoLane?: Partial<LaneDefinition> } = {}): LaneSet {
  const autoLane: LaneDefinition = {
    name: 'auto',
    qualify: { complexity: ['simple'] },
    allowedPaths: ['docs/**', 'src/feature/**'],
    roleRouting: {},
    gateSet: 'gate1',
    mergePolicy: 'auto',
    verifier,
    ...over.autoLane,
  };
  const cautious: LaneDefinition = {
    name: 'cautious',
    qualify: { complexity: ['complex'] },
    allowedPaths: ['**'],
    roleRouting: {},
    gateSet: 'full-ladder',
    mergePolicy: 'hold',
    verifier,
  };
  return { lanes: [autoLane, cautious], mostCautiousLane: 'cautious', declaredPhases: ['velocity'] };
}

const SIMPLE_VERDICT: ClassifierVerdict = { complexity: 'simple' };

/**
 * A green, in-scope, verifier-gated, widened, auto-policy input — the happy
 * path. Every other test perturbs exactly one dimension to isolate an arm.
 */
function happyInput(over: Partial<MergeDecisionInput> = {}): MergeDecisionInput {
  return {
    laneSet: makeLaneSet(),
    riskPathMap: [],
    defaultMinLevel: 'green',
    mode: 'velocity',
    verdict: SIMPLE_VERDICT,
    classifierLevel: 'green',
    touchedPaths: ['docs/readme.md'],
    verifierStatus: GOOD_STATUS,
    autonomyWidened: () => true,
    complianceForced: false,
    ...over,
  };
}

// ---- precedence arms (first match wins) -----------------------------------

describe('decideMerge — precedence (fail-safe, first-match-wins)', () => {
  it('1. verifier withheld → escalate verifier-withheld (beats an otherwise-perfect input)', () => {
    // Everything else is the happy path; only the verifier status is weak.
    const r = decideMerge(happyInput({ verifierStatus: WEAK_STATUS }));
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('verifier-withheld');
  });

  it('1b. lane with NO verifier → escalate verifier-withheld (no-verifier path)', () => {
    const r = decideMerge(
      happyInput({ laneSet: makeLaneSet({ autoLane: { verifier: undefined } }) }),
    );
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('verifier-withheld');
  });

  it('2. compliance forced (verifier OK) → escalate compliance-forced', () => {
    const r = decideMerge(happyInput({ complianceForced: true }));
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('compliance-forced');
  });

  it('3. out-of-scope touched path → escalate out-of-scope', () => {
    // Touches a path outside the auto lane's allowedPaths (docs/** | src/feature/**).
    const r = decideMerge(happyInput({ touchedPaths: ['src/secret/keys.ts'] }));
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('out-of-scope');
  });

  it('4. assignment fallback-most-cautious → escalate lane-fallback-most-cautious', () => {
    // A null verdict forces fallback to the most-cautious lane (which has a
    // verifier, so the gate passes and the fallback arm is actually reached).
    const r = decideMerge(happyInput({ verdict: null, touchedPaths: ['docs/x.md'] }));
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('lane-fallback-most-cautious');
      expect(r.assignment.kind).toBe('fallback-most-cautious');
    }
  });

  it('5a. effective risk forced to orange by a risk-path floor → escalate risk-ineligible', () => {
    const riskPathMap: RiskPathMap = [{ paths: ['docs/**'], minLevel: 'orange' }];
    const r = decideMerge(happyInput({ riskPathMap }));
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('risk-ineligible');
      expect(r.effectiveRisk).toBe('orange');
    }
  });

  it('5b. classifierLevel red NEVER auto-merges, even when autonomy is widened', () => {
    const r = decideMerge(happyInput({ classifierLevel: 'red', autonomyWidened: () => true }));
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('risk-ineligible');
      expect(r.effectiveRisk).toBe('red');
    }
  });

  it('6. autonomy not widened (DEFAULT) → escalate autonomy-not-widened [SAFE-BY-DEFAULT]', () => {
    // Green + verifier-gated + in-scope + eligible, but autonomy is withheld.
    const r = decideMerge(happyInput({ autonomyWidened: () => false }));
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('autonomy-not-widened');
  });

  it('7. eligible + widened + capped review-then-auto → hold awaiting-independent-review', () => {
    // A yellow default-minimum caps the auto lane's policy to review-then-auto
    // (yellow is NOT orange/red, so rule 5 does not fire — rule 7 does).
    const r = decideMerge(happyInput({ defaultMinLevel: 'yellow' }));
    expect(r.kind).toBe('hold');
    if (r.kind === 'hold') {
      expect(r.reason).toBe('awaiting-independent-review');
      expect(r.mergePolicy).toBe('review-then-auto');
      expect(r.effectiveRisk).toBe('yellow');
    }
  });

  it('8. green + verifier-gated + in-scope + eligible + widened + auto → auto-merge', () => {
    const r = decideMerge(happyInput());
    expect(r.kind).toBe('auto-merge');
    if (r.kind === 'auto-merge') {
      expect(r.lane.name).toBe('auto');
      expect(r.effectiveRisk).toBe('green');
      expect(r.mergePolicy).toBe('auto');
      expect(r.verifierGate.kind).toBe('verifier-gated');
      expect(r.eligibility.kind).toBe('eligible');
    }
  });
});

// ---- safe-by-default invariants -------------------------------------------

describe('decideMerge — safe-by-default invariants', () => {
  it('with autonomyWidened always false, NO input combination yields auto-merge', () => {
    const notWidened = (): boolean => false;
    const verdicts: (ClassifierVerdict | null)[] = [SIMPLE_VERDICT, { complexity: 'complex' }, null];
    const levels: RiskLevel[] = ['green', 'yellow', 'orange', 'red'];
    const pathSets: string[][] = [['docs/readme.md'], ['src/feature/x.ts'], ['src/secret/k.ts']];
    const statuses: VerifierStatus[] = [GOOD_STATUS, WEAK_STATUS];
    const defaults: RiskLevel[] = ['green', 'yellow'];

    for (const verdict of verdicts) {
      for (const classifierLevel of levels) {
        for (const touchedPaths of pathSets) {
          for (const verifierStatus of statuses) {
            for (const defaultMinLevel of defaults) {
              for (const complianceForced of [false, true]) {
                const r = decideMerge(
                  happyInput({
                    verdict,
                    classifierLevel,
                    touchedPaths,
                    verifierStatus,
                    defaultMinLevel,
                    complianceForced,
                    autonomyWidened: notWidened,
                  }),
                );
                expect(r.kind).not.toBe('auto-merge');
              }
            }
          }
        }
      }
    }
  });

  it('green + verifier-gated + in-scope + NOT widened escalates (does not auto-merge)', () => {
    const r = decideMerge(happyInput({ autonomyWidened: () => false }));
    expect(r.kind).toBe('escalate');
  });

  it('red never auto-merges across every widened predicate', () => {
    for (const widened of [() => true, () => false, (l: RiskLevel) => l !== 'red']) {
      const r = decideMerge(happyInput({ classifierLevel: 'red', autonomyWidened: widened }));
      expect(r.kind).not.toBe('auto-merge');
    }
  });
});
