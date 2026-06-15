# Lane Engine — Pure Evaluation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, side-effect-free evaluation core of the Lane Engine (ARCH-AC-LANE-ENGINE / STACK-AC-LANE-ENGINE) — lane config parsing, lane assignment, the non-configurable scope tripwire, the escalate-only risk-path floor, lifecycle-mode resolution, merge-eligibility composition, and the earn-in predicate — as a self-contained, exhaustively unit-tested module with no pipeline I/O.

**Architecture:** Declarative config parsed once with a zod schema into a frozen `LaneSet`; all evaluation is pure functions over `(resolved data, input) → discriminated-union result`. Fail-closed sum types (no `null`, no thrown errors on policy questions). Evaluation order is fixed in one function so "no config can suppress the tripwire" is structurally true. Lifecycle mode is flattened *before* evaluation, so the tripwire and risk-floor structurally cannot vary by mode. This plan delivers a library; Plan 2 wires it into the pipeline (config load, classifier verdict, run-state, FSM hooks, decision-escalation, Postgres).

**Tech Stack:** TypeScript (ESM, Node16 module resolution — **all relative imports use the `.js` suffix**), zod@4 (schema), minimatch@10 (glob matching, `{ dot: true }` — the codebase's established matcher), vitest (co-located `*.test.ts`).

**Branch:** `feat/lane-engine-core` off `main`. All files live under `packages/daemon/src/control-plane/lane-engine/`. Run commands from `packages/daemon/`.

---

## Spec references

- L1: `.specify/functional/merge-decision.md` (FUNC-AC-MERGE-DECISION v2.2) — risk floor, lanes, scope tripwire, earn-in (+ pre-approved auto-promote)
- L2: `.specify/architecture/lane-engine.md` (ARCH-AC-LANE-ENGINE) — data model, evaluation order, error handling
- L3: `.specify/stack/lane-engine-ts.md` (STACK-AC-LANE-ENGINE) — TS patterns, schema shape, gotchas

## File structure

All under `packages/daemon/src/control-plane/lane-engine/`:

| File | Responsibility |
|---|---|
| `types.ts` | All shared types and discriminated unions. Type-only, no runtime. |
| `match.ts` | `matchesAny(path, patterns)` — minimatch wrapper (the one glob dialect). |
| `risk.ts` | `RISK_ORDER`, `maxRiskLevel`, `applyRiskPathFloor` — risk levels + escalate-only floor. |
| `tripwire.ts` | `evaluateTripwire(touched, lane)` — the non-configurable scope check. |
| `assign.ts` | `assignLane(resolvedLaneSet, verdict)` — exactly-one-match or fallback-most-cautious. |
| `schema.ts` | zod schemas + `parseLaneSet(raw)` — validate at activation, freeze, coherence checks. |
| `resolve-mode.ts` | `resolveForMode(laneSet, mode)` — flatten per-mode maps to a `ResolvedLaneSet`. |
| `eligibility.ts` | `capPolicy`, `evaluateMergeEligibility(input)` — fixed-order composition. |
| `earn-in.ts` | `evaluateEarnIn(record, policy)` — pure track-record predicate. |
| `index.ts` | Barrel — the module's public surface. |

Each non-type file has a co-located `*.test.ts`.

---

### Task 1: Core types

**Files:**
- Create: `packages/daemon/src/control-plane/lane-engine/types.ts`

Type-only module — no behavior, so no unit test; it is verified by `tsc` in later tasks that import it. Define the complete type surface up front so every later task references consistent names.

- [ ] **Step 1: Write the types file**

```typescript
// packages/daemon/src/control-plane/lane-engine/types.ts

/** Risk levels, ordered least → most cautious. */
export type RiskLevel = 'green' | 'yellow' | 'orange' | 'red';

/** Classifier complexity (mirrors the existing ClassificationResult enum). */
export type Complexity = 'simple' | 'standard' | 'complex';

/** Kind of change, used for lane qualification. */
export type ChangeKind =
  | 'docs'
  | 'formatting'
  | 'dependency-refresh'
  | 'feature'
  | 'fix'
  | 'refactor'
  | 'config'
  | 'other';

/** How a qualifying change may join the shared mainline. Ordered by caution. */
export type MergePolicy = 'auto' | 'review-then-auto' | 'hold';

/** A field that may be a single value, or declared per lifecycle phase. */
export type ByMode<T> = T | Record<string, T>;

export interface LaneQualification {
  complexity?: Complexity[];
  changeKind?: ChangeKind[];
}

export interface BatchReviewPolicy {
  enabled: boolean;
  cadence: string;
}

export interface EarnInPolicy {
  cleanMerges: number;
  bounceFreeDays: number;
}

/** Raw lane declaration as it arrives from a config pack (pre mode-resolution). */
export interface LaneDefinition {
  name: string;
  qualify: LaneQualification;
  allowedPaths: string[];
  roleRouting: Record<string, string>;
  gateSet: ByMode<string>;
  mergePolicy: ByMode<MergePolicy>;
  postMergeReview?: BatchReviewPolicy;
  earnIn?: EarnInPolicy;
}

/** A validated, frozen set of lanes for one deployment + its declared phases. */
export interface LaneSet {
  lanes: LaneDefinition[];
  mostCautiousLane: string;
  declaredPhases: string[];
}

/** A lane after lifecycle-mode resolution: gateSet & mergePolicy are plain values. */
export interface ResolvedLane {
  name: string;
  qualify: LaneQualification;
  allowedPaths: string[];
  roleRouting: Record<string, string>;
  gateSet: string;
  mergePolicy: MergePolicy;
  postMergeReview?: BatchReviewPolicy;
  earnIn?: EarnInPolicy;
}

export interface ModeResolution {
  /** The phase actually used, or null when degraded. */
  mode: string | null;
  degraded: boolean;
  cause?: string;
}

export interface ResolvedLaneSet {
  lanes: ResolvedLane[];
  mostCautiousLane: string;
  resolution: ModeResolution;
}

/** The classifier output fields lane assignment matches on. */
export interface ClassifierVerdict {
  complexity?: Complexity;
  changeKind?: ChangeKind;
}

export type LaneAssignmentResult =
  | { kind: 'assigned'; lane: string; reasons: string[] }
  | {
      kind: 'fallback-most-cautious';
      lane: string;
      cause: 'no-match' | 'ambiguous' | 'verdict-unavailable';
    };

export type TripwireVerdict =
  | { kind: 'in-scope'; touched: string[] }
  | { kind: 'out-of-scope'; touched: string[]; outside: string[] };

export interface RiskPathEntry {
  paths: string[];
  minLevel: RiskLevel;
}
export type RiskPathMap = RiskPathEntry[];

export interface EligibilityInput {
  lane: ResolvedLane;
  classifierLevel: RiskLevel;
  riskPathMap: RiskPathMap;
  touchedPaths: string[];
}

export type Eligibility =
  | {
      kind: 'eligible';
      effectiveRisk: RiskLevel;
      gateSet: string;
      mergePolicy: MergePolicy;
      tripwire: TripwireVerdict;
    }
  | {
      kind: 'escalate';
      effectiveRisk: RiskLevel;
      reason: 'out-of-scope';
      tripwire: TripwireVerdict;
    };

export interface LaneTrackRecord {
  cleanMerges: number;
  bounceFreeDays: number;
}

export type EarnInResult =
  | { kind: 'not-eligible'; reasons: string[] }
  | { kind: 'eligible-for-promotion'; evidence: LaneTrackRecord };
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/daemon && pnpm exec tsc --noEmit`
Expected: PASS (no errors). The file is declarations only.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/control-plane/lane-engine/types.ts
git commit -m "feat(lane-engine): core types and discriminated unions"
```

---

### Task 2: Glob matching helper

**Files:**
- Create: `packages/daemon/src/control-plane/lane-engine/match.ts`
- Test: `packages/daemon/src/control-plane/lane-engine/match.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/daemon/src/control-plane/lane-engine/match.test.ts
import { describe, it, expect } from 'vitest';
import { matchesAny } from './match.js';

describe('matchesAny', () => {
  it('matches an exact path', () => {
    expect(matchesAny('package.json', ['package.json'])).toBe(true);
  });

  it('matches a recursive glob', () => {
    expect(matchesAny('docs/guide/intro.md', ['docs/**'])).toBe(true);
  });

  it('matches dotfiles (dot: true)', () => {
    expect(matchesAny('.github/workflows/ci.yml', ['.github/**'])).toBe(true);
  });

  it('returns false when no pattern matches', () => {
    expect(matchesAny('src/index.ts', ['docs/**', '**/*.md'])).toBe(false);
  });

  it('returns false for an empty pattern list', () => {
    expect(matchesAny('anything', [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/match.test.ts`
Expected: FAIL — cannot resolve `./match.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/daemon/src/control-plane/lane-engine/match.ts
import { minimatch } from 'minimatch';

/**
 * True if `path` matches any of the glob patterns. Uses `{ dot: true }` to
 * match dotfiles — the same dialect used by the containment path rules, so
 * one glob behavior serves the whole codebase.
 */
export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/match.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/lane-engine/match.ts packages/daemon/src/control-plane/lane-engine/match.test.ts
git commit -m "feat(lane-engine): glob matching helper (minimatch, dot:true)"
```

---

### Task 3: Risk levels and the escalate-only risk-path floor

**Files:**
- Create: `packages/daemon/src/control-plane/lane-engine/risk.ts`
- Test: `packages/daemon/src/control-plane/lane-engine/risk.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/daemon/src/control-plane/lane-engine/risk.test.ts
import { describe, it, expect } from 'vitest';
import { maxRiskLevel, applyRiskPathFloor } from './risk.js';
import type { RiskPathMap } from './types.js';

describe('maxRiskLevel', () => {
  it('returns the single level when given one', () => {
    expect(maxRiskLevel('green')).toBe('green');
  });

  it('returns the most cautious of several', () => {
    expect(maxRiskLevel('green', 'orange', 'yellow')).toBe('orange');
    expect(maxRiskLevel('yellow', 'red')).toBe('red');
  });
});

describe('applyRiskPathFloor', () => {
  const map: RiskPathMap = [
    { paths: ['migrations/**'], minLevel: 'red' },
    { paths: ['src/auth/**'], minLevel: 'orange' },
  ];

  it('raises the level when a touched path matches a floor entry', () => {
    expect(applyRiskPathFloor('green', map, ['src/auth/login.ts'])).toBe('orange');
  });

  it('takes the most cautious matched floor', () => {
    expect(applyRiskPathFloor('green', map, ['src/auth/x.ts', 'migrations/001.sql'])).toBe('red');
  });

  it('never lowers the classifier level (raise-only)', () => {
    expect(applyRiskPathFloor('red', map, ['docs/readme.md'])).toBe('red');
  });

  it('returns the classifier level when nothing matches', () => {
    expect(applyRiskPathFloor('yellow', map, ['docs/readme.md'])).toBe('yellow');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/risk.test.ts`
Expected: FAIL — cannot resolve `./risk.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/daemon/src/control-plane/lane-engine/risk.ts
import type { RiskLevel, RiskPathMap } from './types.js';
import { matchesAny } from './match.js';

/** Risk levels ordered least → most cautious. Index = caution rank. */
export const RISK_ORDER: readonly RiskLevel[] = ['green', 'yellow', 'orange', 'red'];

/** The most cautious of the given levels. At least one level is required. */
export function maxRiskLevel(first: RiskLevel, ...rest: RiskLevel[]): RiskLevel {
  return [first, ...rest].reduce((acc, level) =>
    RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(acc) ? level : acc,
  );
}

/**
 * Raise-only floor: the effective risk is the most cautious of the classifier
 * level and every risk-path entry whose patterns match a touched path. By
 * construction (a max over levels) a map entry can never lower a level.
 */
export function applyRiskPathFloor(
  classifierLevel: RiskLevel,
  riskPathMap: RiskPathMap,
  touchedPaths: string[],
): RiskLevel {
  const matchedFloors = riskPathMap
    .filter((entry) => touchedPaths.some((p) => matchesAny(p, entry.paths)))
    .map((entry) => entry.minLevel);
  return maxRiskLevel(classifierLevel, ...matchedFloors);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/risk.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/lane-engine/risk.ts packages/daemon/src/control-plane/lane-engine/risk.test.ts
git commit -m "feat(lane-engine): risk levels + escalate-only risk-path floor"
```

---

### Task 4: The scope tripwire

**Files:**
- Create: `packages/daemon/src/control-plane/lane-engine/tripwire.ts`
- Test: `packages/daemon/src/control-plane/lane-engine/tripwire.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/daemon/src/control-plane/lane-engine/tripwire.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateTripwire } from './tripwire.js';

describe('evaluateTripwire', () => {
  it('is in-scope when every touched path matches the allowlist', () => {
    const v = evaluateTripwire(['docs/a.md', 'README.md'], { allowedPaths: ['docs/**', '*.md'] });
    expect(v.kind).toBe('in-scope');
    expect(v.touched).toEqual(['docs/a.md', 'README.md']);
  });

  it('is out-of-scope and lists the offending paths', () => {
    const v = evaluateTripwire(['docs/a.md', 'src/secret.ts'], { allowedPaths: ['docs/**'] });
    expect(v.kind).toBe('out-of-scope');
    if (v.kind === 'out-of-scope') {
      expect(v.outside).toEqual(['src/secret.ts']);
    }
  });

  it('is in-scope for an empty change', () => {
    expect(evaluateTripwire([], { allowedPaths: ['docs/**'] }).kind).toBe('in-scope');
  });

  it('treats every path as out-of-scope when nothing matches', () => {
    const v = evaluateTripwire(['a.ts', 'b.ts'], { allowedPaths: ['docs/**'] });
    expect(v.kind).toBe('out-of-scope');
    if (v.kind === 'out-of-scope') {
      expect(v.outside).toEqual(['a.ts', 'b.ts']);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/tripwire.test.ts`
Expected: FAIL — cannot resolve `./tripwire.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/daemon/src/control-plane/lane-engine/tripwire.ts
import type { ResolvedLane, TripwireVerdict } from './types.js';
import { matchesAny } from './match.js';

/**
 * Compare what a change ACTUALLY touched against the lane's declared allowed
 * scope. Pure: callers pass the real touched-path set (from a merge-base git
 * diff in the integration layer). The non-configurable safeguard against the
 * platform's own lane-classification errors.
 */
export function evaluateTripwire(
  touched: string[],
  lane: Pick<ResolvedLane, 'allowedPaths'>,
): TripwireVerdict {
  const outside = touched.filter((p) => !matchesAny(p, lane.allowedPaths));
  return outside.length === 0
    ? { kind: 'in-scope', touched }
    : { kind: 'out-of-scope', touched, outside };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/tripwire.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/lane-engine/tripwire.ts packages/daemon/src/control-plane/lane-engine/tripwire.test.ts
git commit -m "feat(lane-engine): non-configurable scope tripwire"
```

---

### Task 5: Lane assignment

**Files:**
- Create: `packages/daemon/src/control-plane/lane-engine/assign.ts`
- Test: `packages/daemon/src/control-plane/lane-engine/assign.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/daemon/src/control-plane/lane-engine/assign.test.ts
import { describe, it, expect } from 'vitest';
import { assignLane } from './assign.js';
import type { ResolvedLane, ResolvedLaneSet } from './types.js';

function lane(name: string, qualify: ResolvedLane['qualify']): ResolvedLane {
  return {
    name,
    qualify,
    allowedPaths: ['**'],
    roleRouting: {},
    gateSet: 'full-ladder',
    mergePolicy: 'hold',
  };
}

const laneSet: ResolvedLaneSet = {
  lanes: [
    lane('trivial', { complexity: ['simple'], changeKind: ['docs'] }),
    lane('standard', { complexity: ['standard', 'complex'] }),
  ],
  mostCautiousLane: 'standard-hold',
  resolution: { mode: 'velocity', degraded: false },
};

describe('assignLane', () => {
  it('assigns the single lane whose qualification matches', () => {
    const r = assignLane(laneSet, { complexity: 'simple', changeKind: 'docs' });
    expect(r.kind).toBe('assigned');
    expect(r.lane).toBe('trivial');
  });

  it('falls back to most-cautious on no match', () => {
    const r = assignLane(laneSet, { complexity: 'simple', changeKind: 'feature' });
    expect(r).toEqual({ kind: 'fallback-most-cautious', lane: 'standard-hold', cause: 'no-match' });
  });

  it('falls back to most-cautious on ambiguous (2+) match', () => {
    const ambiguous: ResolvedLaneSet = {
      ...laneSet,
      lanes: [lane('a', { complexity: ['simple'] }), lane('b', { complexity: ['simple'] })],
    };
    const r = assignLane(ambiguous, { complexity: 'simple' });
    expect(r).toEqual({ kind: 'fallback-most-cautious', lane: 'standard-hold', cause: 'ambiguous' });
  });

  it('falls back to most-cautious when the verdict is unavailable', () => {
    const r = assignLane(laneSet, null);
    expect(r).toEqual({
      kind: 'fallback-most-cautious',
      lane: 'standard-hold',
      cause: 'verdict-unavailable',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/assign.test.ts`
Expected: FAIL — cannot resolve `./assign.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/daemon/src/control-plane/lane-engine/assign.ts
import type {
  ClassifierVerdict,
  LaneAssignmentResult,
  ResolvedLane,
  ResolvedLaneSet,
} from './types.js';

/**
 * A lane qualifies if every declared criterion is satisfied by the verdict. A
 * criterion that is declared but unsatisfiable by the verdict (missing field
 * or value not in the allowed list) fails the lane. A lane with no criteria is
 * a catch-all.
 */
function qualifies(lane: ResolvedLane, verdict: ClassifierVerdict): boolean {
  const { complexity, changeKind } = lane.qualify;
  if (complexity && (verdict.complexity === undefined || !complexity.includes(verdict.complexity))) {
    return false;
  }
  if (changeKind && (verdict.changeKind === undefined || !changeKind.includes(verdict.changeKind))) {
    return false;
  }
  return true;
}

function reasonsFor(lane: ResolvedLane, verdict: ClassifierVerdict): string[] {
  const reasons: string[] = [];
  if (lane.qualify.complexity && verdict.complexity) reasons.push(`complexity=${verdict.complexity}`);
  if (lane.qualify.changeKind && verdict.changeKind) reasons.push(`changeKind=${verdict.changeKind}`);
  if (reasons.length === 0) reasons.push('catch-all (no qualification criteria)');
  return reasons;
}

/**
 * Assign a change to exactly one lane. Zero matches, 2+ matches, or an
 * unavailable verdict all fail safe to the deployment's most-cautious lane,
 * with the cause recorded. There is no specificity ranking — qualifications
 * are expected to be mutually exclusive (the schema flags overlaps).
 */
export function assignLane(
  laneSet: ResolvedLaneSet,
  verdict: ClassifierVerdict | null,
): LaneAssignmentResult {
  if (verdict === null) {
    return {
      kind: 'fallback-most-cautious',
      lane: laneSet.mostCautiousLane,
      cause: 'verdict-unavailable',
    };
  }
  const matches = laneSet.lanes.filter((lane) => qualifies(lane, verdict));
  if (matches.length === 1) {
    const only = matches[0]!;
    return { kind: 'assigned', lane: only.name, reasons: reasonsFor(only, verdict) };
  }
  return {
    kind: 'fallback-most-cautious',
    lane: laneSet.mostCautiousLane,
    cause: matches.length === 0 ? 'no-match' : 'ambiguous',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/assign.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/lane-engine/assign.ts packages/daemon/src/control-plane/lane-engine/assign.test.ts
git commit -m "feat(lane-engine): lane assignment with fail-safe fallback"
```

---

### Task 6: Config schema + `parseLaneSet`

**Files:**
- Create: `packages/daemon/src/control-plane/lane-engine/schema.ts`
- Test: `packages/daemon/src/control-plane/lane-engine/schema.test.ts`

**Coherence rule (this task's key decision):** a lane's `gateSet` and `mergePolicy` are either both plain values, or both per-mode maps over an identical set of declared phases. This keeps mode resolution well-defined (one chosen phase yields both fields) and matches the config-pack example. The schema enforces it.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/daemon/src/control-plane/lane-engine/schema.test.ts
import { describe, it, expect } from 'vitest';
import { parseLaneSet } from './schema.js';

const valid = {
  declaredPhases: ['velocity', 'clinical'],
  mostCautiousLane: 'standard',
  lanes: [
    {
      name: 'trivial',
      qualify: { complexity: ['simple'], changeKind: ['docs'] },
      allowedPaths: ['docs/**', '**/*.md'],
      roleRouting: { implement: 'cheap-implementer', review: 'frontier-reviewer' },
      gateSet: 'gate1-deterministic-only',
      mergePolicy: 'auto',
      earnIn: { cleanMerges: 10, bounceFreeDays: 3 },
    },
    {
      name: 'standard',
      qualify: { complexity: ['standard', 'complex'] },
      allowedPaths: ['**'],
      roleRouting: { implement: 'cheap-implementer' },
      gateSet: { velocity: 'gate1-plus-review', clinical: 'full-ladder' },
      mergePolicy: { velocity: 'review-then-auto', clinical: 'hold' },
    },
  ],
};

describe('parseLaneSet', () => {
  it('accepts a valid lane set and freezes it', () => {
    const r = parseLaneSet(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.laneSet)).toBe(true);
      expect(r.laneSet.lanes).toHaveLength(2);
    }
  });

  it('rejects an empty allowedPaths (would look like a tripwire storm)', () => {
    const bad = structuredClone(valid);
    bad.lanes[0]!.allowedPaths = [];
    const r = parseLaneSet(bad);
    expect(r.ok).toBe(false);
  });

  it('rejects mostCautiousLane that names no declared lane', () => {
    const bad = structuredClone(valid);
    bad.mostCautiousLane = 'nonexistent';
    const r = parseLaneSet(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('mostCautiousLane');
  });

  it('rejects a per-mode map referencing an undeclared phase', () => {
    const bad = structuredClone(valid);
    (bad.lanes[1]!.gateSet as Record<string, string>) = { velocity: 'x', staging: 'y' };
    (bad.lanes[1]!.mergePolicy as Record<string, string>) = { velocity: 'auto', staging: 'hold' };
    const r = parseLaneSet(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('staging');
  });

  it('rejects a lane where gateSet is per-mode but mergePolicy is not (coherence)', () => {
    const bad = structuredClone(valid);
    (bad.lanes[1]!.mergePolicy as unknown) = 'hold';
    const r = parseLaneSet(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('coherent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/schema.test.ts`
Expected: FAIL — cannot resolve `./schema.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/daemon/src/control-plane/lane-engine/schema.ts
import { z } from 'zod';
import type { LaneSet } from './types.js';

const Complexity = z.enum(['simple', 'standard', 'complex']);
const ChangeKind = z.enum([
  'docs',
  'formatting',
  'dependency-refresh',
  'feature',
  'fix',
  'refactor',
  'config',
  'other',
]);
const MergePolicy = z.enum(['auto', 'review-then-auto', 'hold']);

/** A field that is either a single value or a per-phase map. */
const byMode = <T extends z.ZodTypeAny>(value: T) => z.union([value, z.record(z.string(), value)]);

const BatchReviewPolicy = z.object({ enabled: z.boolean(), cadence: z.string() });
const EarnInPolicy = z.object({
  cleanMerges: z.number().int().min(0),
  bounceFreeDays: z.number().int().min(0),
});

const LaneDefinitionSchema = z.object({
  name: z.string().min(1),
  qualify: z.object({
    complexity: z.array(Complexity).optional(),
    changeKind: z.array(ChangeKind).optional(),
  }),
  allowedPaths: z.array(z.string()).min(1),
  roleRouting: z.record(z.string(), z.string()),
  gateSet: byMode(z.string()),
  mergePolicy: byMode(MergePolicy),
  postMergeReview: BatchReviewPolicy.optional(),
  earnIn: EarnInPolicy.optional(),
});

const LaneSetSchema = z.object({
  lanes: z.array(LaneDefinitionSchema).min(1),
  mostCautiousLane: z.string().min(1),
  declaredPhases: z.array(z.string()).min(1),
});

export type ParseLaneSetResult =
  | { ok: true; laneSet: Readonly<LaneSet> }
  | { ok: false; errors: string[] };

function isModeMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Validate raw config-pack lane data at pack-activation time. On any error the
 * result is `ok: false` with messages — the caller keeps the previous pack
 * (atomic activation). On success the lane set is deep-frozen.
 */
export function parseLaneSet(raw: unknown): ParseLaneSetResult {
  const parsed = LaneSetSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const data = parsed.data;
  const errors: string[] = [];
  const phases = new Set(data.declaredPhases);

  if (!data.lanes.some((l) => l.name === data.mostCautiousLane)) {
    errors.push(`mostCautiousLane '${data.mostCautiousLane}' is not a declared lane`);
  }

  for (const lane of data.lanes) {
    const gsMap = isModeMap(lane.gateSet);
    const mpMap = isModeMap(lane.mergePolicy);
    if (gsMap !== mpMap) {
      errors.push(
        `lane '${lane.name}': gateSet and mergePolicy must be coherent — either both per-mode maps or both plain values`,
      );
    }
    if (gsMap && mpMap) {
      const gsKeys = Object.keys(lane.gateSet as Record<string, unknown>);
      const mpKeys = Object.keys(lane.mergePolicy as Record<string, unknown>);
      for (const key of [...gsKeys, ...mpKeys]) {
        if (!phases.has(key)) {
          errors.push(`lane '${lane.name}': per-mode field references undeclared phase '${key}'`);
        }
      }
      if (gsKeys.length !== mpKeys.length || gsKeys.some((k) => !mpKeys.includes(k))) {
        errors.push(`lane '${lane.name}': gateSet and mergePolicy must declare the same phases`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, laneSet: Object.freeze(data) as Readonly<LaneSet> };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/schema.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/lane-engine/schema.ts packages/daemon/src/control-plane/lane-engine/schema.test.ts
git commit -m "feat(lane-engine): config schema + parseLaneSet with coherence checks"
```

---

### Task 7: Lifecycle-mode resolution

**Files:**
- Create: `packages/daemon/src/control-plane/lane-engine/resolve-mode.ts`
- Test: `packages/daemon/src/control-plane/lane-engine/resolve-mode.test.ts`

Flatten per-mode maps to plain values so the evaluation path never sees a mode. Degraded resolution (unreadable/undeclared mode) picks, per lane, the phase whose `mergePolicy` is most cautious and takes both fields from it. The schema (Task 6) guarantees `gateSet` and `mergePolicy` are coherent maps over identical phases, so one chosen phase resolves both.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/daemon/src/control-plane/lane-engine/resolve-mode.test.ts
import { describe, it, expect } from 'vitest';
import { resolveForMode } from './resolve-mode.js';
import type { LaneSet } from './types.js';

const laneSet: LaneSet = {
  declaredPhases: ['velocity', 'clinical'],
  mostCautiousLane: 'standard',
  lanes: [
    {
      name: 'trivial',
      qualify: { complexity: ['simple'] },
      allowedPaths: ['docs/**'],
      roleRouting: {},
      gateSet: 'gate1',
      mergePolicy: 'auto',
    },
    {
      name: 'standard',
      qualify: { complexity: ['standard'] },
      allowedPaths: ['**'],
      roleRouting: {},
      gateSet: { velocity: 'gate1-plus-review', clinical: 'full-ladder' },
      mergePolicy: { velocity: 'review-then-auto', clinical: 'hold' },
    },
  ],
};

describe('resolveForMode', () => {
  it('resolves per-mode maps to the named phase', () => {
    const r = resolveForMode(laneSet, 'velocity');
    expect(r.resolution).toEqual({ mode: 'velocity', degraded: false, cause: undefined });
    const standard = r.lanes.find((l) => l.name === 'standard')!;
    expect(standard.gateSet).toBe('gate1-plus-review');
    expect(standard.mergePolicy).toBe('review-then-auto');
  });

  it('leaves plain fields untouched', () => {
    const trivial = resolveForMode(laneSet, 'clinical').lanes.find((l) => l.name === 'trivial')!;
    expect(trivial.gateSet).toBe('gate1');
    expect(trivial.mergePolicy).toBe('auto');
  });

  it('degrades to the most cautious phase when the mode is null', () => {
    const r = resolveForMode(laneSet, null);
    expect(r.resolution.degraded).toBe(true);
    const standard = r.lanes.find((l) => l.name === 'standard')!;
    // most cautious mergePolicy among {review-then-auto, hold} is hold (clinical)
    expect(standard.mergePolicy).toBe('hold');
    expect(standard.gateSet).toBe('full-ladder');
  });

  it('degrades when the mode is not a declared phase', () => {
    const r = resolveForMode(laneSet, 'staging');
    expect(r.resolution).toEqual({ mode: null, degraded: true, cause: 'mode-undeclared:staging' });
    expect(r.lanes.find((l) => l.name === 'standard')!.mergePolicy).toBe('hold');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/resolve-mode.test.ts`
Expected: FAIL — cannot resolve `./resolve-mode.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/daemon/src/control-plane/lane-engine/resolve-mode.ts
import type {
  LaneDefinition,
  LaneSet,
  MergePolicy,
  ResolvedLane,
  ResolvedLaneSet,
} from './types.js';

const POLICY_CAUTION: Record<MergePolicy, number> = { auto: 0, 'review-then-auto': 1, hold: 2 };

function isModeMap<T>(field: T | Record<string, T>): field is Record<string, T> {
  return typeof field === 'object' && field !== null;
}

/** The phase key whose mergePolicy is most cautious (ties: first declared). */
function mostCautiousPhase(mergePolicy: Record<string, MergePolicy>): string {
  return Object.entries(mergePolicy).reduce((acc, [phase, policy]) =>
    POLICY_CAUTION[policy] > POLICY_CAUTION[mergePolicy[acc]!] ? phase : acc,
  Object.keys(mergePolicy)[0]!);
}

function resolveLane(lane: LaneDefinition, mode: string | null): ResolvedLane {
  const variant = isModeMap(lane.mergePolicy) || isModeMap(lane.gateSet);
  if (!variant) {
    return { ...lane, gateSet: lane.gateSet as string, mergePolicy: lane.mergePolicy as MergePolicy };
  }
  // Schema guarantees both are maps over identical phases when variant.
  const mpMap = lane.mergePolicy as Record<string, MergePolicy>;
  const gsMap = lane.gateSet as Record<string, string>;
  const phase = mode !== null && mode in mpMap ? mode : mostCautiousPhase(mpMap);
  return { ...lane, gateSet: gsMap[phase]!, mergePolicy: mpMap[phase]! };
}

/**
 * Flatten a LaneSet for a deployment's current lifecycle mode into a
 * ResolvedLaneSet the evaluation functions consume. An unreadable (null) or
 * undeclared mode degrades each variant lane to its most cautious phase, with
 * the cause recorded. The evaluation path never sees the mode after this.
 */
export function resolveForMode(laneSet: LaneSet, mode: string | null): ResolvedLaneSet {
  const known = mode !== null && laneSet.declaredPhases.includes(mode);
  const degraded = !known;
  let cause: string | undefined;
  if (mode === null) cause = 'mode-unreadable';
  else if (!known) cause = `mode-undeclared:${mode}`;

  return {
    lanes: laneSet.lanes.map((lane) => resolveLane(lane, known ? mode : null)),
    mostCautiousLane: laneSet.mostCautiousLane,
    resolution: { mode: known ? mode : null, degraded, cause },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/resolve-mode.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/lane-engine/resolve-mode.ts packages/daemon/src/control-plane/lane-engine/resolve-mode.test.ts
git commit -m "feat(lane-engine): lifecycle-mode resolution (fail-safe to most cautious)"
```

---

### Task 8: Merge-eligibility composition

**Files:**
- Create: `packages/daemon/src/control-plane/lane-engine/eligibility.ts`
- Test: `packages/daemon/src/control-plane/lane-engine/eligibility.test.ts`

Fixed, non-configurable order: risk-path floor → tripwire → gate-set + capped merge policy. Encoding the order in one function keeps "no config can suppress the tripwire" structurally true. `capPolicy` is the floor's teeth: orange/red caps any lane's policy to `hold`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/daemon/src/control-plane/lane-engine/eligibility.test.ts
import { describe, it, expect } from 'vitest';
import { capPolicy, evaluateMergeEligibility } from './eligibility.js';
import type { EligibilityInput, ResolvedLane } from './types.js';

function makeLane(over: Partial<ResolvedLane> = {}): ResolvedLane {
  return {
    name: 'trivial',
    qualify: {},
    allowedPaths: ['docs/**'],
    roleRouting: {},
    gateSet: 'gate1',
    mergePolicy: 'auto',
    ...over,
  };
}

describe('capPolicy', () => {
  it('leaves green-eligible auto as auto', () => {
    expect(capPolicy('auto', 'green')).toBe('auto');
  });
  it('caps auto to review-then-auto at yellow', () => {
    expect(capPolicy('auto', 'yellow')).toBe('review-then-auto');
  });
  it('caps any policy to hold at orange and red', () => {
    expect(capPolicy('auto', 'orange')).toBe('hold');
    expect(capPolicy('review-then-auto', 'red')).toBe('hold');
  });
  it('never loosens a lane that is already more cautious', () => {
    expect(capPolicy('hold', 'green')).toBe('hold');
  });
});

describe('evaluateMergeEligibility', () => {
  it('is eligible in-scope, capping policy by effective risk', () => {
    const input: EligibilityInput = {
      lane: makeLane(),
      classifierLevel: 'green',
      riskPathMap: [],
      touchedPaths: ['docs/a.md'],
    };
    const r = evaluateMergeEligibility(input);
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.effectiveRisk).toBe('green');
      expect(r.mergePolicy).toBe('auto');
      expect(r.gateSet).toBe('gate1');
    }
  });

  it('escalates out-of-scope changes regardless of risk', () => {
    const input: EligibilityInput = {
      lane: makeLane(),
      classifierLevel: 'green',
      riskPathMap: [],
      touchedPaths: ['src/secret.ts'],
    };
    const r = evaluateMergeEligibility(input);
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('out-of-scope');
  });

  it('caps an auto lane to hold when a risk-path floor raises to orange', () => {
    const input: EligibilityInput = {
      lane: makeLane({ allowedPaths: ['**'], mergePolicy: 'auto' }),
      classifierLevel: 'green',
      riskPathMap: [{ paths: ['migrations/**'], minLevel: 'orange' }],
      touchedPaths: ['migrations/001.sql'],
    };
    const r = evaluateMergeEligibility(input);
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.effectiveRisk).toBe('orange');
      expect(r.mergePolicy).toBe('hold');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/eligibility.test.ts`
Expected: FAIL — cannot resolve `./eligibility.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/daemon/src/control-plane/lane-engine/eligibility.ts
import type { Eligibility, EligibilityInput, MergePolicy, RiskLevel } from './types.js';
import { applyRiskPathFloor } from './risk.js';
import { evaluateTripwire } from './tripwire.js';

const POLICY_CAUTION: Record<MergePolicy, number> = { auto: 0, 'review-then-auto': 1, hold: 2 };

/** The most permissive policy each risk level may earn (the caution ceiling). */
const RISK_MAX_POLICY: Record<RiskLevel, MergePolicy> = {
  green: 'auto',
  yellow: 'review-then-auto',
  orange: 'hold',
  red: 'hold',
};

/**
 * A lane's mergePolicy is a request, not a grant. Cap it by the effective risk
 * level: return the MORE cautious of the lane's policy and the risk ceiling.
 */
export function capPolicy(lanePolicy: MergePolicy, risk: RiskLevel): MergePolicy {
  const ceiling = RISK_MAX_POLICY[risk];
  return POLICY_CAUTION[lanePolicy] >= POLICY_CAUTION[ceiling] ? lanePolicy : ceiling;
}

/**
 * The fixed, non-configurable evaluation order at the integration boundary:
 * risk-path floor (raise-only) → tripwire → gate-set + capped merge policy.
 * Compliance and earned-autonomy compose OVER this result in the merge-decision
 * caller (Plan 2) — never inside here.
 */
export function evaluateMergeEligibility(input: EligibilityInput): Eligibility {
  const effectiveRisk = applyRiskPathFloor(input.classifierLevel, input.riskPathMap, input.touchedPaths);
  const tripwire = evaluateTripwire(input.touchedPaths, input.lane);
  if (tripwire.kind !== 'in-scope') {
    return { kind: 'escalate', effectiveRisk, reason: 'out-of-scope', tripwire };
  }
  return {
    kind: 'eligible',
    effectiveRisk,
    gateSet: input.lane.gateSet,
    mergePolicy: capPolicy(input.lane.mergePolicy, effectiveRisk),
    tripwire,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/eligibility.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/lane-engine/eligibility.ts packages/daemon/src/control-plane/lane-engine/eligibility.test.ts
git commit -m "feat(lane-engine): fixed-order merge-eligibility composition + policy cap"
```

---

### Task 9: Earn-in predicate

**Files:**
- Create: `packages/daemon/src/control-plane/lane-engine/earn-in.ts`
- Test: `packages/daemon/src/control-plane/lane-engine/earn-in.test.ts`

Pure predicate over a recorded track record. Meeting the bar yields `eligible-for-promotion` (the caller raises a DecisionRequest, or — under a pre-approved policy — auto-promotes; per FUNC-AC-MERGE-DECISION v2.2). This function never flips an autonomy flag.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/daemon/src/control-plane/lane-engine/earn-in.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateEarnIn } from './earn-in.js';

describe('evaluateEarnIn', () => {
  const policy = { cleanMerges: 10, bounceFreeDays: 3 };

  it('is eligible when the record meets the bar', () => {
    const r = evaluateEarnIn({ cleanMerges: 12, bounceFreeDays: 5 }, policy);
    expect(r.kind).toBe('eligible-for-promotion');
  });

  it('is not eligible when cleanMerges is short, with a reason', () => {
    const r = evaluateEarnIn({ cleanMerges: 4, bounceFreeDays: 5 }, policy);
    expect(r.kind).toBe('not-eligible');
    if (r.kind === 'not-eligible') expect(r.reasons.join()).toContain('cleanMerges');
  });

  it('is not eligible when bounceFreeDays is short', () => {
    const r = evaluateEarnIn({ cleanMerges: 20, bounceFreeDays: 1 }, policy);
    expect(r.kind).toBe('not-eligible');
    if (r.kind === 'not-eligible') expect(r.reasons.join()).toContain('bounceFreeDays');
  });

  it('is not eligible when the lane declares no earn-in policy', () => {
    const r = evaluateEarnIn({ cleanMerges: 999, bounceFreeDays: 999 }, undefined);
    expect(r.kind).toBe('not-eligible');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/earn-in.test.ts`
Expected: FAIL — cannot resolve `./earn-in.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/daemon/src/control-plane/lane-engine/earn-in.ts
import type { EarnInPolicy, EarnInResult, LaneTrackRecord } from './types.js';

/**
 * Pure earn-in predicate. A lane with no declared policy is never eligible. The
 * caller decides what eligibility means (raise a promotion DecisionRequest, or
 * auto-promote under a pre-approved + verifier-gated policy) — this function
 * never widens autonomy itself.
 */
export function evaluateEarnIn(
  record: LaneTrackRecord,
  policy: EarnInPolicy | undefined,
): EarnInResult {
  if (policy === undefined) {
    return { kind: 'not-eligible', reasons: ['lane declares no earn-in policy'] };
  }
  const reasons: string[] = [];
  if (record.cleanMerges < policy.cleanMerges) {
    reasons.push(`cleanMerges ${record.cleanMerges} < required ${policy.cleanMerges}`);
  }
  if (record.bounceFreeDays < policy.bounceFreeDays) {
    reasons.push(`bounceFreeDays ${record.bounceFreeDays} < required ${policy.bounceFreeDays}`);
  }
  return reasons.length === 0
    ? { kind: 'eligible-for-promotion', evidence: record }
    : { kind: 'not-eligible', reasons };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine/earn-in.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/lane-engine/earn-in.ts packages/daemon/src/control-plane/lane-engine/earn-in.test.ts
git commit -m "feat(lane-engine): pure earn-in predicate"
```

---

### Task 10: Public barrel + full-suite verification

**Files:**
- Create: `packages/daemon/src/control-plane/lane-engine/index.ts`

- [ ] **Step 1: Write the barrel**

```typescript
// packages/daemon/src/control-plane/lane-engine/index.ts
export * from './types.js';
export { matchesAny } from './match.js';
export { RISK_ORDER, maxRiskLevel, applyRiskPathFloor } from './risk.js';
export { evaluateTripwire } from './tripwire.js';
export { assignLane } from './assign.js';
export { parseLaneSet, type ParseLaneSetResult } from './schema.js';
export { resolveForMode } from './resolve-mode.js';
export { capPolicy, evaluateMergeEligibility } from './eligibility.js';
export { evaluateEarnIn } from './earn-in.js';
```

- [ ] **Step 2: Typecheck, lint, and run the whole module suite**

Run: `cd packages/daemon && pnpm exec tsc --noEmit`
Expected: PASS.

Run: `cd packages/daemon && pnpm exec eslint src/control-plane/lane-engine --suppressions-location .eslint-suppressions.json`
Expected: PASS (0 errors). Note: this repo enforces `@typescript-eslint/strict-boolean-expressions` — nullable values must use explicit `=== undefined` / `!== undefined`, never truthiness. The plan's code already does (e.g. `verdict === null`, `policy === undefined`).

Run: `cd packages/daemon && pnpm exec vitest run src/control-plane/lane-engine`
Expected: PASS — all module tests green (≈34 across 8 test files).

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/control-plane/lane-engine/index.ts
git commit -m "feat(lane-engine): public barrel; pure evaluation core complete"
```

---

## Traceability update (final task)

- [ ] Update `.specify/stack/lane-engine-ts.md` `code_paths`/`test_paths` and `.specify/traceability.yml` `STACK-AC-LANE-ENGINE` to list the created files (the path-existence validator requires real files — only add paths now that they exist). Set `STACK-AC-LANE-ENGINE` status to reflect partial implementation per the corpus convention (leave `draft` until the integration in Plan 2 lands, or mark a documented sub-status). Run `pnpm test` in `packages/daemon` to confirm `traceability-paths.test.ts` (the reciprocity + path guards) stays green.

```bash
git add .specify/stack/lane-engine-ts.md .specify/traceability.yml
git commit -m "chore(traceability): wire STACK-AC-LANE-ENGINE code_paths to the implemented core"
```

---

## Out of scope — Plan 2 (pipeline integration)

These are deliberately excluded here; each touches the live pipeline and is its own plan:
- Extend `config.ts` ConfigSchema with `lanes` / `riskPathMap` / `lifecycleMode`; call `parseLaneSet` at pack activation (atomic — keep previous pack on failure).
- Extend the classifier verdict (`classifier-schema.ts`) with `changeKind` + declared scope.
- Add `LaneAssignment` + `TripwireVerdict` fields to `RunState` (`types.ts`) via the run-state pattern; persist via `runWriter.upsertRun`.
- Two FSM hooks (`phases.ts`): post-`classify` → `assignLane`; pre-`integrate` → compute merge-base touched paths (`scope-audit` pattern) → `evaluateMergeEligibility` → `escalate`/proceed. Re-evaluate every integrate attempt.
- `LaneTrackRecord` + `LaneDecisionRecord` Postgres tables; `recordOutcome` in the disposition transaction.
- Promotion DecisionRequest builder in `control-plane/decision-escalation/build-request.ts` (mirror `buildL2GateRequest`); pre-approved auto-promote path gated on verifier presence (FUNC-AC-VERIFIER-GATE).
- Compliance gate + earned-autonomy compose over the engine result.

---

## Self-Review

**1. Spec coverage:** assignment (Task 5), non-configurable tripwire (Task 4 + fixed order in Task 8), escalate-only risk floor (Task 3), lifecycle-mode resolution incl. degraded (Task 7), config schema validated at activation incl. empty-allowlist + undeclared-phase rejection (Task 6), merge-eligibility with policy cap (Task 8), earn-in predicate (Task 9). Gate execution, compliance/earned-autonomy composition, config-pack loading, persistence, and the FSM hooks are explicitly Plan 2 (the L3's "Concerns This Spec Does Not Cover" matches this split). ✓

**2. Placeholder scan:** every code step contains complete, runnable code and exact commands. No TBD/TODO. ✓

**3. Type consistency:** `RiskLevel`, `MergePolicy`, `ResolvedLane`, `LaneSet`, `ResolvedLaneSet`, `EligibilityInput`, `Eligibility`, `LaneAssignmentResult`, `TripwireVerdict`, `EarnInResult` defined once in Task 1 and used verbatim. `POLICY_CAUTION` appears in resolve-mode (Task 7) and eligibility (Task 8) as local constants (intentional — no shared mutable state in pure modules). `matchesAny` (Task 2) consumed by risk (Task 3) and tripwire (Task 4). `mostCautiousPhase`/`capPolicy`/`maxRiskLevel` names consistent across tasks. ✓
