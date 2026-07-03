# P5 — Operator-Approved Production Release Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-deployment, Operator-approved production-release lane in the daemon Control Plane: a discriminated-union declared release path, an append-only per-deployment Release Ledger, per-deployment since-last-release proposal assembly, the 4th (`release`) DecisionRequest builder, and a 3-shape executor with preview-before-change and per-shape fail-safe — all reusing existing seams (`@auto-claude/decision-index`, the governed raise→publish→notify sequence, `readDeclaredData('landing')`).

**Architecture:** Each deployment gets a release lane. The Control Plane derives that deployment's Last-Released Marker from its own append-only Release Ledger (a new `release_ledger` Postgres schema mirroring `@auto-claude/decision-index`), diffs its trunk since that marker to assemble a Release Proposal (preview — mutates nothing), and — on `proposeRelease` — raises the reserved `phase:'release'` decision through the existing Decision Ledger. The release decision is **always raised** and **never** routed through merge earn-in/auto-approve. On the Operator's approval, a 3-shape executor carries out the deployment's declared path (`platform-performs` / `trigger-automated` / `record-only`) with a per-shape fail-safe, appending every proposal, decision, execution, and completion to the Release Ledger. The Last-Released Marker is **derived** from the most recent `released` event, never stored twice.

**Tech Stack:** TypeScript (NodeNext ESM), Zod v4, Drizzle ORM + `postgres-js`, PGlite (in-memory Postgres for tests), Vitest, `@octokit/rest`.

## Global Constraints

- **A production release is ALWAYS a per-event Operator approval** — never automatic, never pre-approved, at any level of earned or pre-approved autonomy. There must be **no** code path that resolves the release decision on the platform's judgement. (FUNC-AC-RELEASE constraint 1; ARCH §Error Handling "Autonomy bypass attempt"; STACK Key-Decision "Always raises".)
- **Preview never mutates production.** The proposal + the raised DecisionRequest *are* the preview. Appending the proposal to the ledger is allowed (it is not a production change); touching the Running Production System during preview is not. (STACK Gotcha "Preview never mutates".)
- **Last-Released Marker is DERIVED, not stored** — it is the `target_revision` of the most recent `released` event (an `execution` or `completion` event whose outcome is `released`). The two handed-off outcomes (`triggered-awaiting`, `recorded-awaiting-human`) are non-final and do NOT advance the marker. (ARCH §Data Model; STACK Key-Decision.)
- **Fail closed everywhere:** missing/malformed declared path → refuse, no execution event, no production change; Release Ledger unavailable → refuse to execute; decision transport degraded → mark deployment degraded, do not proceed. (ARCH §Error Handling.)
- **Structured-safe decision context ONLY** — never raw commit bodies, handoff notes, or L2 feedback in the release decision `context`/`question`. Carry only structured, known-safe fields (deployment, counts, target revision, covered issue numbers). (STACK Key-Decision; `merge-decision/build-request.ts:23` invariant.)
- **The bash `scripts/release.sh` stays** in `code_paths` as the reference implementation of the `platform-performs` shape (the platform's own deployment) until the TS lane fully lands. Net-new TS `code_paths` are added only for files that exist post-build. (STACK Scope note.)
- **The LIVE release drill** (actually promoting a real deployment's production through a shape) is Operator-gated and OUT of this code unit — mirroring how P2's Phase-9 live run was carved out. This plan builds the executor + fail-safe against **injectable ports** exercised by fakes; the real `launchctl`/`git`/trigger side effects are wired but proven live only under Operator gate.

---

## Ground Truth

Substrate recon is in `docs/superpowers/plans/2026-07-03-p5-release-lane.groundtruth.md` (verified vs `origin/main`). Do **not** restate it. One correction confirmed during planning and used throughout this plan: the deployment-registry files live at `packages/daemon/src/control-plane/deployment-registry/` (not `packages/daemon/src/deployment-registry/`), and the governed raise→publish→notify block is at `phases.ts:2520-2567` (the L3 cites `2522`). Also load-bearing: `sanitizeDecisionRequest` and `resolveDecisionPublisher` are **closures inside `createPhaseHandlers`** (`phases.ts:202,228`), NOT exported helpers — so the Operator-triggered release lane mirrors the *sequence* using the underlying primitives (`GitHubBlockPublisher` from `decision-escalation/github-block-notifier.js`, `withGovernedDecisionMarking` from `decision-escalation/manager.js`, `decisionManager.ledger().raise/notify`). **The sanitizer is reused, not elided:** Task 5 extracts the sanitize body (`phases.ts:228-252`) into a shared exported helper `applyDecisionSanitization(pipeline, req)` that BOTH `phases.ts`'s closure and the release lane call, and the lane is injected the deployment's `SanitizationPipeline` (`@auto-claude/sanitization`). Two further seams the fixes depend on: the authoritative Operator-answer reader is `parseCockpitAnswer(comments, decisionId)` (`decision-escalation/resume-consumer.ts:82`), and the per-tick answered-decision consumer pattern is `finding-dismissal/apply-consumer.ts` — the model for the release-resolution consumer (below). `posted:false` from `GitHubBlockPublisher.ensure` is the fail-closed retry state (`github-block-notifier.ts:180`), never a success.

## File Structure

**New package** `packages/release-ledger/` (mirrors `packages/decision-index/` structure — its own `release_ledger` pgSchema, single-writer, migrations):
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `drizzle.config.ts`
- `src/schema.ts` — `pgSchema("release_ledger")` with one append-only `release_events` table
- `src/db.ts` — `openDb` / `openReadOnlyDb` / `withTx` + advisory-lock single-writer (mirror `decision-index/src/db.ts`; lock name `auto-claude:release-ledger:writer`)
- `src/migrate.ts` — `migrate()` into the `release_ledger` schema
- `src/ledger.ts` — `createReleaseLedger({databaseUrl})` factory (openDb + migrate) + `ReleaseLedgerWriter` facade + `ReleaseLedgerReader` read-only projection
- `src/index.ts` — public surface: writer facade + read-only projection only
- `drizzle/` — generated migration (drizzle-kit)
- `test/helpers/temp-db.ts` (mirror `decision-index/test/helpers/temp-db.ts`) + test files

**New daemon orchestration** `packages/daemon/src/control-plane/release/`:
- `types.ts` — `ReleaseProposal`, `CoveredCommit`, `PreviewResult`, `TrunkReader`, `PromotionPort`, `DeclaredReleasePath` re-export
- `proposal.ts` — `assembleReleaseProposal(...)` (REPLACES the vestigial `../release.ts`)
- `build-request.ts` — `buildReleaseDecisionRequest(...)` (the 4th builder)
- `release-ledger-manager.ts` — `ReleaseLedgerManager` (per-deployment lifecycle, fail-closed `#broken`, mirrors `DecisionIndexManager`)
- `executor.ts` — `createReleaseLane(...)` returning `previewRelease` / `proposeRelease` / `resolveRelease` / `recordCompletion`
- `resolve-consumer.ts` — `resolveAnsweredReleases(...)`: the per-tick sweep that reads the verified Operator answer for each pending `phase:'release'` decision and drives `resolveRelease` (mirrors `finding-dismissal/apply-consumer.ts` + `resumeParkedRuns`) — this is the approval→execution path

**New shared helper:**
- `packages/daemon/src/control-plane/decision-escalation/sanitize-request.ts` — `applyDecisionSanitization(pipeline, req)`, the exported extraction of the `phases.ts:228-252` closure body; `phases.ts`'s `sanitizeDecisionRequest` closure delegates to it and the release lane calls it directly (ONE implementation)

**Modified:**
- `packages/daemon/src/control-plane/deployment-registry/schema.ts:95-105` — `productionReleasePath` → discriminated 3-shape union
- `packages/daemon/src/control-plane/deployment-registry/types.ts:63-73` — `LandingTarget.productionReleasePath` type + exported `DeclaredReleasePath`
- ~18 test fixtures + `cause-driven-tasks.config.json` + `auto-claude.config.json` (if present) — migrate `productionReleasePath` string → union shape
- `packages/daemon/src/control-plane/phases.ts:228-252` — the `sanitizeDecisionRequest` closure now delegates to the shared `applyDecisionSanitization` (no behavior change)
- `packages/daemon/src/control-plane/daemon.ts:38,2123-2133` and `server.ts:5,38,205-215` — rewire the `release` handler to a **per-deployment** lane (`release(deployment)`); add the `resolveAnsweredReleases` sweep to the per-tick loop
- `packages/daemon/src/control-plane/release.ts` — **deleted** (vestigial); its two gate tests (`phase0-single-trunk.gate.test.ts`, `phase0-halt.gate.test.ts`) rewired/retired
- `.specify/traceability.yml` + `.specify/stack/release-ts.md` — add net-new `code_paths`

---

## Task 1: Declared release path — discriminated 3-shape union, actually consumed

**Files:**
- Modify: `packages/daemon/src/control-plane/deployment-registry/schema.ts:95-105` (LandingTargetSchema)
- Modify: `packages/daemon/src/control-plane/deployment-registry/types.ts:63-73` (LandingTarget) + add `DeclaredReleasePath`
- Modify (fixtures): every file listed by `grep -rn productionReleasePath packages` (~18 test files) + `cause-driven-tasks.config.json:56`, and `auto-claude.config.json` if it declares one
- Test: `packages/daemon/src/control-plane/deployment-registry/release-path.test.ts` (new)

**Interfaces:**
- Produces: `export type DeclaredReleasePath = { kind: 'platform-performs' } | { kind: 'trigger-automated'; trigger: string } | { kind: 'record-only'; procedure: string }`; `LandingTarget.productionReleasePath: DeclaredReleasePath`. Tasks 3-5 read it via `registry.readDeclaredData(id, 'landing')` then narrow the `.productionReleasePath`.

- [ ] **Step 1: Write the failing test** — `deployment-registry/release-path.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { DeploymentProfileSchema } from './schema.js';

const base = {
  id: 'acme/widgets',
  repositories: [{ owner: 'acme', name: 'widgets' }],
  riskPathMap: { entries: [], defaultMinLevel: 'green' },
  defaultMinLevel: 'green',
  laneSet: {},
  complianceReviewers: [],
  honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
  capabilityBindings: [],
};
const withPath = (p: unknown) => ({ ...base, landing: { landsOn: 'main', productionReleasePath: p } });

describe('landing.productionReleasePath — discriminated 3-shape union', () => {
  it('accepts platform-performs', () => {
    expect(DeploymentProfileSchema.safeParse(withPath({ kind: 'platform-performs' })).success).toBe(true);
  });
  it('accepts trigger-automated with a trigger', () => {
    expect(DeploymentProfileSchema.safeParse(withPath({ kind: 'trigger-automated', trigger: 'deploy.yml' })).success).toBe(true);
  });
  it('accepts record-only with a procedure', () => {
    expect(DeploymentProfileSchema.safeParse(withPath({ kind: 'record-only', procedure: 'runbook#release' })).success).toBe(true);
  });
  it('REJECTS a bare string (the old inert shape)', () => {
    expect(DeploymentProfileSchema.safeParse(withPath('tag-and-deploy')).success).toBe(false);
  });
  it('REJECTS trigger-automated without a trigger', () => {
    expect(DeploymentProfileSchema.safeParse(withPath({ kind: 'trigger-automated' })).success).toBe(false);
  });
  it('REJECTS record-only without a procedure', () => {
    expect(DeploymentProfileSchema.safeParse(withPath({ kind: 'record-only' })).success).toBe(false);
  });
  it('REJECTS an unknown kind', () => {
    expect(DeploymentProfileSchema.safeParse(withPath({ kind: 'yolo' })).success).toBe(false);
  });
  it('REJECTS extra keys on platform-performs (strict)', () => {
    expect(DeploymentProfileSchema.safeParse(withPath({ kind: 'platform-performs', extra: 1 })).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @auto-claude/daemon test release-path`
Expected: FAIL — the bare-string case currently passes (old `z.string().min(1)`).

- [ ] **Step 3: Upgrade the schema** — `deployment-registry/schema.ts`, replace line 98 (`productionReleasePath: z.string().min(1),`) inside `LandingTargetSchema` with the discriminated union:

```ts
    productionReleasePath: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('platform-performs') }).strict(),                             // param-less BY DESIGN (honest for the platform's own deployment = scripts/release.sh); a promote-command/target for non-platform deployments is DEFERRED (the union is extensible)
      z.object({ kind: z.literal('trigger-automated'), trigger: z.string().min(1) }).strict(), // `trigger` = an opaque validated string; the executor SSRF/DNS-guards it at dispatch (see Task 5); concrete dispatch shape DEFERRED
      z.object({ kind: z.literal('record-only'), procedure: z.string().min(1) }).strict(),     // a human completes it
    ]),
```

- [ ] **Step 4: Upgrade the type** — `deployment-registry/types.ts`, add above `LandingTarget` (line ~63) and change the field:

```ts
/** How a deployment's production release is carried out (one of three declared shapes). */
export type DeclaredReleasePath =
  | { kind: 'platform-performs' }
  | { kind: 'trigger-automated'; trigger: string }
  | { kind: 'record-only'; procedure: string };
```
Then change `productionReleasePath: string;` (line 66) to `productionReleasePath: DeclaredReleasePath;`.

- [ ] **Step 5: Migrate every fixture.** Run `grep -rln "productionReleasePath: '" packages` and in each hit replace the string form with a union shape. Mapping: `'release-sh'` → `{ kind: 'platform-performs' }`; `'tag-and-deploy'` (and any other string) → `{ kind: 'trigger-automated', trigger: 'tag-and-deploy' }`. Also update `cause-driven-tasks.config.json:56` (`"productionReleasePath": "tag-and-deploy"` → `"productionReleasePath": { "kind": "trigger-automated", "trigger": "tag-and-deploy" }`) and `auto-claude.config.json` if it declares one (`release-sh` → `{ "kind": "platform-performs" }`). These fixtures do not exercise release semantics; the mapping preserves intent.

- [ ] **Step 6: Run the new test + the whole deployment-registry suite to verify no fixture regressed**

Run: `pnpm --filter @auto-claude/daemon test deployment-registry release-path`
Expected: PASS (all shapes accepted, string rejected, no fixture parse failures).

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/control-plane/deployment-registry cause-driven-tasks.config.json auto-claude.config.json 2>/dev/null; git add -A packages/daemon
git commit --no-verify -m "feat(release): consume landing.productionReleasePath as a discriminated 3-shape union"
```

**Acceptance:** `DeploymentProfileSchema` accepts each of the three shapes and rejects a bare string, a missing discriminant field, an unknown kind, and extra keys; the whole daemon suite still parses every migrated fixture.

---

## Task 2: The per-deployment Release Ledger — append-only Postgres event journal

**Files:**
- Create: `packages/release-ledger/` (new package — see File Structure). Mirror `packages/decision-index/`: `package.json`, `tsconfig.json`, `vitest.config.ts`, `drizzle.config.ts`, `src/schema.ts`, `src/db.ts`, `src/migrate.ts`, `src/ledger.ts`, `src/index.ts`, `drizzle/`, `test/helpers/temp-db.ts`.
- Reuse anchors: `packages/decision-index/src/schema.ts:104-120` (`audit_log` bigint-identity append-only shape), `packages/decision-index/src/db.ts:35,123-146,176-199` (advisory-lock single-writer + `withTx`), `packages/decision-index/src/index-writer.ts:94-132` (`createIndexWriter` = openDb + migrate factory), `packages/decision-index/src/migrate.ts` (migrate into a named pgSchema), `packages/decision-index/test/helpers/temp-db.ts` (PGlite test harness).
- Test: `packages/release-ledger/test/ledger.test.ts` (PGlite), `packages/release-ledger/test/marker.test.ts` (PGlite).

**Interfaces:**
- Produces:
```ts
export type ReleaseEventKind = 'proposal' | 'decision' | 'attempt' | 'execution' | 'completion' | 'resolved';
// `attempt` is the outbox-style INTENT marker (mirrors decision-index's reserve→effect→commit): appended
// IMMEDIATELY BEFORE a production side effect (promote / fireTrigger) so a crash AFTER the effect but BEFORE
// its `execution` record is recoverable WITHOUT re-firing an external_effect. record-only has no side effect
// and needs no `attempt`. Recovery from an `attempt` with no following terminal `execution` fails CLOSED
// (never re-executes; records `failed` for the Operator to verify).
// `resolved` is the terminal DECISION-ack: appended LAST, only after the Decision Ledger is terminalized.
// It makes "this release's Operator decision has been fully consumed" self-contained in the Release Ledger,
// so the per-tick consumer can enumerate crash-stranded releases without reading Decision-Ledger status.
// (`resolved` is orthogonal to the release OUTCOME — a handed-off release is `resolved` yet awaits a `completion`.)
export type ReleaseOutcome = 'released' | 'triggered-awaiting' | 'recorded-awaiting-human' | 'failed';
export interface AppendReleaseEvent {
  releaseId: string;
  deployment: string;
  event: ReleaseEventKind;
  targetRevision: string | null;   // set on proposal/attempt/execution/completion; null on decision/resolved
  detail: Record<string, unknown>; // structured-safe; carries proposal | {answer} | {shape} | {outcome}
  at?: string;                     // ISO; defaults to now
}
export interface ReleaseEventRow {
  id: number; releaseId: string; deployment: string; event: ReleaseEventKind;
  targetRevision: string | null; detail: Record<string, unknown>; at: string;
}
export interface ReleaseLedgerWriter {
  append(e: AppendReleaseEvent): Promise<void>;
  /** Atomic first-proposal insert: appends the `proposal` event only if none exists for
   *  the release_id (relies on the partial unique index — swallows the unique violation as
   *  a no-op). Race-safe against concurrent proposes. Returns true if THIS call inserted it. */
  appendProposalIfAbsent(e: AppendReleaseEvent & { event: 'proposal' }): Promise<boolean>;
  reader(): ReleaseLedgerReader;
  close(): Promise<void>;
}
export interface ReleaseLedgerReader {
  eventsForRelease(deployment: string, releaseId: string): Promise<ReleaseEventRow[]>;
  lastReleasedMarker(deployment: string): Promise<string | undefined>;
  latestOutcome(deployment: string, releaseId: string): Promise<ReleaseOutcome | undefined>;
  /** OPEN releases: those with a `proposal` event but NO terminal `resolved` event —
   *  i.e. the Operator decision has not been fully consumed yet (undecided, decided-but-not-
   *  executed after a crash, or executed-but-not-terminalized after a crash). The self-contained
   *  enumeration source for the resolve-consumer (no decision-index phase filtering). `detail`
   *  carries the proposal (incl. its recorded issueNumber). Guarantees the sweep re-picks every
   *  crash-stranded release until `resolveRelease` appends `resolved`. */
  openReleases(): Promise<{ deployment: string; releaseId: string; detail: Record<string, unknown> }[]>;
}
export function createReleaseLedger(opts: { databaseUrl: string; skipMigrate?: boolean }): Promise<ReleaseLedgerWriter>;
```
Consumed by Tasks 3 (`lastReleasedMarker`), 5 (`append`, `eventsForRelease`, `latestOutcome`).

- [ ] **Step 1: Scaffold the package.** Copy `packages/decision-index/{package.json,tsconfig.json,vitest.config.ts,drizzle.config.ts}` to `packages/release-ledger/`, rename to `@auto-claude/release-ledger`, drop deps not needed (`ajv`, `ulid`, `@auto-claude/sanitizer-redaction`), keep `drizzle-orm`, `postgres`, `zod`, dev `@electric-sql/pglite`, `drizzle-kit`, `vitest`, `typescript`, `@types/node`. Point `drizzle.config.ts` `schema` at `./src/schema.ts`, `out` at `./drizzle`.

- [ ] **Step 2: Write the schema** — `src/schema.ts` (mirror `decision-index/src/schema.ts:104-120`):

```ts
import { pgSchema, text, bigint, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Dedicated Postgres schema namespace for the per-deployment release ledger. */
export const releaseLedger = pgSchema('release_ledger');

/**
 * Append-only release event journal. A single release is the ordered run of
 * events sharing a release_id; there is NO mutable per-release row (a proposal
 * appended before the decision is just an earlier event). The Last-Released
 * Marker is DERIVED from the most recent `released` event — never stored twice.
 */
export const releaseEvents = releaseLedger.table('release_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  release_id: text('release_id').notNull(),
  deployment: text('deployment').notNull(),
  event: text('event').notNull(),            // proposal | decision | attempt | execution | completion | resolved
  target_revision: text('target_revision'),  // nullable (decision/resolved events carry none)
  detail_json: text('detail_json'),          // structured-safe: proposal | {answer} | {shape} | {outcome}
  at: text('at').notNull(),
}, (t) => ({
  // ATOMIC proposal-uniqueness: at most one `proposal` row per release_id. Makes
  // `appendProposalIfAbsent` race-safe (two concurrent proposes cannot both insert
  // a proposal) — the DB rejects the second at COMMIT, not a read-then-append check.
  oneProposalPerRelease: uniqueIndex('release_events_one_proposal_per_release')
    .on(t.release_id)
    .where(sql`${t.event} = 'proposal'`),
}));
```

- [ ] **Step 3: Port `db.ts` and `migrate.ts`.** Copy `decision-index/src/db.ts` verbatim, changing only `WRITER_LOCK_NAME` to `"auto-claude:release-ledger:writer"` and the schema import to `./schema.js`. Copy `decision-index/src/migrate.ts`, changing `migrationsSchema` to `"release_ledger"`. Generate the baseline migration: `pnpm --filter @auto-claude/release-ledger exec drizzle-kit generate`.

- [ ] **Step 4: Write the failing ledger append/read test** — `test/ledger.test.ts` (PGlite, mirror `decision-index/test/helpers/temp-db.ts`; migrate the `release_ledger` schema in-memory):

```ts
import { describe, it, expect } from 'vitest';
import { makeTempLedger } from './helpers/temp-db.js'; // returns { writer, cleanup }

describe('ReleaseLedger append-only + read-back', () => {
  it('reads a release id end to end in append order', async () => {
    const { writer, cleanup } = await makeTempLedger();
    const r = 'release:acme/widgets:abc12345';
    await writer.append({ releaseId: r, deployment: 'acme/widgets', event: 'proposal', targetRevision: 'abc12345', detail: { covered: 2 } });
    await writer.append({ releaseId: r, deployment: 'acme/widgets', event: 'decision', targetRevision: null, detail: { answer: 'approve' } });
    await writer.append({ releaseId: r, deployment: 'acme/widgets', event: 'execution', targetRevision: 'abc12345', detail: { outcome: 'released' } });
    const rows = await writer.reader().eventsForRelease('acme/widgets', r);
    expect(rows.map((x) => x.event)).toEqual(['proposal', 'decision', 'execution']);
    await cleanup();
  });
});
```

- [ ] **Step 5: Write the failing marker-derivation test** — `test/marker.test.ts` (PGlite):

```ts
import { describe, it, expect } from 'vitest';
import { makeTempLedger } from './helpers/temp-db.js';

describe('Last-Released Marker is DERIVED from the most recent released event', () => {
  it('advances on a released execution, not on triggered-awaiting', async () => {
    const { writer, cleanup } = await makeTempLedger();
    const d = 'acme/widgets';
    await writer.append({ releaseId: 'r1', deployment: d, event: 'execution', targetRevision: 'sha-A', detail: { outcome: 'released' } });
    expect(await writer.reader().lastReleasedMarker(d)).toBe('sha-A');
    await writer.append({ releaseId: 'r2', deployment: d, event: 'execution', targetRevision: 'sha-B', detail: { outcome: 'triggered-awaiting' } });
    expect(await writer.reader().lastReleasedMarker(d)).toBe('sha-A'); // NOT advanced by a non-final outcome
    await writer.append({ releaseId: 'r2', deployment: d, event: 'completion', targetRevision: 'sha-B', detail: { outcome: 'released' } });
    expect(await writer.reader().lastReleasedMarker(d)).toBe('sha-B'); // completion(released) advances it
    await writer.append({ releaseId: 'r3', deployment: d, event: 'execution', targetRevision: 'sha-C', detail: { outcome: 'failed' } });
    expect(await writer.reader().lastReleasedMarker(d)).toBe('sha-B'); // failed never advances
    await cleanup();
  });
  it('returns undefined when the deployment has never released', async () => {
    const { writer, cleanup } = await makeTempLedger();
    expect(await writer.reader().lastReleasedMarker('never/released')).toBeUndefined();
    await cleanup();
  });
});
```

- [ ] **Step 6: Run to verify both fail**

Run: `pnpm --filter @auto-claude/release-ledger test`
Expected: FAIL — `createReleaseLedger` / `makeTempLedger` not implemented.

- [ ] **Step 7: Implement `src/ledger.ts`.** `createReleaseLedger` mirrors `createIndexWriter` (`openDb({url}) → migrate(db) → return writer`; on error `sql.end()` then rethrow). `append` uses `withTx(db, tx => tx.insert(releaseEvents).values({...}))` (serial writer + per-tx advisory lock inherited from the ported `db.ts`). `appendProposalIfAbsent` inserts the proposal inside `withTx` with `.onConflictDoNothing({ target: ... })` (or catches the unique-violation `23505`) so a concurrent second propose is a no-op, and returns whether a row was inserted (rowCount). `at` defaults to `new Date().toISOString()`. Reader queries:

```ts
async lastReleasedMarker(deployment: string): Promise<string | undefined> {
  // Newest-first scan of execution+completion events; first whose outcome === 'released' wins.
  const rows = await db.select().from(releaseEvents)
    .where(and(eq(releaseEvents.deployment, deployment),
               inArray(releaseEvents.event, ['execution', 'completion'])))
    .orderBy(desc(releaseEvents.id));
  for (const row of rows) {
    const outcome = (JSON.parse(row.detail_json ?? '{}') as { outcome?: string }).outcome;
    if (outcome === 'released') return row.target_revision ?? undefined;
  }
  return undefined;
}
```
`eventsForRelease` selects by `(deployment, release_id)` ordered by `id` asc, parsing `detail_json`. `latestOutcome` reads the newest execution/completion row for the release and returns its `detail.outcome`. `openReleases` groups events by `release_id`, keeps those that have a `proposal` event but NO `resolved` event, and returns `{deployment, releaseId, detail}` (the proposal detail, which carries the recorded `issueNumber`). Add a test: after appending only a `proposal`, `openReleases()` includes it; after appending its `decision` (but not `resolved`) it STILL includes it (crash-stranded); after appending `resolved` it does not.

- [ ] **Step 8: Implement `test/helpers/temp-db.ts`** (mirror decision-index): spin an in-memory PGlite, `pgliteMigrate` the `release_ledger` schema, and construct a `ReleaseLedgerWriter` over the PGlite-backed drizzle handle (inject the db so `append`/reader use it; `createReleaseLedger` is for production postgres-js). Export `makeTempLedger()` → `{ writer, cleanup }`.

- [ ] **Step 9: Write `src/index.ts`** exporting ONLY the writer facade + reader types + `createReleaseLedger` (mirror `decision-index/src/index.ts` — no raw `openDb`/schema on the surface).

- [ ] **Step 10: Run to verify both pass**

Run: `pnpm --filter @auto-claude/release-ledger test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/release-ledger
git commit --no-verify -m "feat(release): append-only per-deployment Release Ledger (Postgres, derived Last-Released Marker)"
```

**Acceptance:** events append and read back in order for a `release_id`; `lastReleasedMarker` returns the most recent `released` event's `target_revision`, does NOT advance on `triggered-awaiting`/`recorded-awaiting-human`/`failed`, and is `undefined` for a never-released deployment; the store fails to init (rethrows) on a bad connection, freeing the connection.

---

## Task 3: Per-deployment proposal assembly — replace the vestigial `release.ts`

**Files:**
- Create: `packages/daemon/src/control-plane/release/types.ts`, `packages/daemon/src/control-plane/release/proposal.ts`
- Delete: `packages/daemon/src/control-plane/release.ts` (vestigial single-repo/all-time PR-model — `release.ts:38,77-124`, never passes `since`, returns `single-trunk-not-applicable`)
- Rewire callers of the deleted module: `daemon.ts:38,2123-2133`, `server.ts:5,205-215` (handled fully in Task 5); retire/rewrite `phase0-single-trunk.gate.test.ts` and `phase0-halt.gate.test.ts` references
- Reuse anchors: `landing-target.ts:48-73` (`resolveLandingTarget` fail-closed narrowing pattern to mirror), `registry.ts:459` (`readDeclaredData(id,'landing')`), `await-checks.ts:95` (octokit `repos.*` call pattern), Task 2's `ReleaseLedgerReader.lastReleasedMarker`
- Test: `packages/daemon/src/control-plane/release/proposal.test.ts` (pure — fake `TrunkReader` + fake reader)

**Interfaces:**
- Produces:
```ts
export interface CoveredCommit { sha: string; subject: string; issueNumbers: number[]; }
export interface ReleaseProposal {
  deployment: string;
  targetRevision: string;              // trunk head sha to release to
  sinceRevision: string | undefined;   // last-released marker (undefined = first release)
  coveredWork: CoveredCommit[];        // structured-safe
  declaredPath: DeclaredReleasePath;   // from Task 1
  summary: string;                     // human-readable, structured-safe
}
export type PreviewResult =
  | { kind: 'proposal'; proposal: ReleaseProposal }
  | { kind: 'nothing-to-release'; deployment: string }
  | { kind: 'unresolvable'; deployment: string; reason: string }; // missing/invalid landing or declared path
export interface TrunkReader {
  getTrunkHead(owner: string, repo: string, branch: string): Promise<{ sha: string }>;
  compareSince(owner: string, repo: string, base: string, head: string): Promise<{ commits: CoveredCommit[] }>;
  listRecent(owner: string, repo: string, head: string): Promise<{ commits: CoveredCommit[] }>;
}
export interface AssembleArgs {
  deployment: string;
  registry: { readDeclaredData(id: string, which: 'landing'): { kind: 'found'; value: unknown } | { kind: 'not-found' } };
  repositories: { owner: string; name: string }[];
  ledgerReader: Pick<ReleaseLedgerReader, 'lastReleasedMarker'>;
  trunkReader: TrunkReader;
}
export function assembleReleaseProposal(args: AssembleArgs): Promise<PreviewResult>;
```
Consumed by Tasks 4 (`ReleaseProposal`) and 5 (`assembleReleaseProposal`, `PreviewResult`). Production `TrunkReader` is octokit-backed: `getTrunkHead` = `repos.getBranch({owner,repo,branch}).data.commit.sha`; `compareSince` = `repos.compareCommits({owner,repo,base,head}).data.commits` mapped to `CoveredCommit` (subject = first line of `commit.message`, `issueNumbers` parsed from `#\d+`); `listRecent` = `repos.listCommits({owner,repo,sha:head})`.

- [ ] **Step 1: Write the failing test** — `release/proposal.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { assembleReleaseProposal, type TrunkReader } from './proposal.js';

const landingFound = (path: unknown) => ({
  readDeclaredData: () => ({ kind: 'found' as const, value: { landsOn: 'main', productionReleasePath: path } }),
});
const repos = [{ owner: 'acme', name: 'widgets' }];
// compareSince and listRecent return DISTINCT commit sets so a wrong-source impl is falsifiable.
const SINCE = [{ sha: 'since-1', subject: 'fix #12', issueNumbers: [12] }];
const RECENT = [{ sha: 'recent-1', subject: 'old #99', issueNumbers: [99] }, { sha: 'recent-2', subject: 'older #98', issueNumbers: [98] }];
const makeTrunk = (headSha: string) => {
  const compareSince = vi.fn(async () => ({ commits: SINCE }));
  const listRecent = vi.fn(async () => ({ commits: RECENT }));
  const trunkReader: TrunkReader = { getTrunkHead: async () => ({ sha: headSha }), compareSince, listRecent };
  return { trunkReader, compareSince, listRecent };
};

describe('assembleReleaseProposal — per-deployment since-last-release', () => {
  it('diffs since the marker (compareSince, base=marker) — NOT recent commits', async () => {
    const { trunkReader, compareSince, listRecent } = makeTrunk('sha-head');
    const res = await assembleReleaseProposal({
      deployment: 'acme/widgets', registry: landingFound({ kind: 'platform-performs' }), repositories: repos,
      ledgerReader: { lastReleasedMarker: async () => 'sha-prev' }, trunkReader,
    });
    expect(res.kind).toBe('proposal');
    if (res.kind !== 'proposal') return;
    expect(compareSince).toHaveBeenCalledWith('acme', 'widgets', 'sha-prev', 'sha-head'); // base = marker
    expect(listRecent).not.toHaveBeenCalled();
    expect(res.proposal.sinceRevision).toBe('sha-prev');
    expect(res.proposal.targetRevision).toBe('sha-head');
    expect(res.proposal.declaredPath).toEqual({ kind: 'platform-performs' });
    expect(res.proposal.coveredWork).toEqual(SINCE); // the since-diff set, not RECENT
  });
  it('reports nothing-to-release when trunk head equals the marker', async () => {
    const { trunkReader } = makeTrunk('sha-head');
    const res = await assembleReleaseProposal({
      deployment: 'acme/widgets', registry: landingFound({ kind: 'platform-performs' }), repositories: repos,
      ledgerReader: { lastReleasedMarker: async () => 'sha-head' }, trunkReader,
    });
    expect(res.kind).toBe('nothing-to-release');
  });
  it('uses listRecent for a first release (no prior marker) and covers that set', async () => {
    const { trunkReader, compareSince, listRecent } = makeTrunk('sha-head');
    const res = await assembleReleaseProposal({
      deployment: 'acme/widgets', registry: landingFound({ kind: 'record-only', procedure: 'runbook' }), repositories: repos,
      ledgerReader: { lastReleasedMarker: async () => undefined }, trunkReader,
    });
    expect(res.kind).toBe('proposal');
    if (res.kind !== 'proposal') return;
    expect(compareSince).not.toHaveBeenCalled();
    expect(listRecent).toHaveBeenCalledWith('acme', 'widgets', 'sha-head');
    expect(res.proposal.sinceRevision).toBeUndefined();
    expect(res.proposal.coveredWork).toEqual(RECENT);
  });
  it('is unresolvable (fail closed) when landing is not declared', async () => {
    const { trunkReader } = makeTrunk('h');
    const res = await assembleReleaseProposal({
      deployment: 'x', registry: { readDeclaredData: () => ({ kind: 'not-found' as const }) }, repositories: repos,
      ledgerReader: { lastReleasedMarker: async () => undefined }, trunkReader,
    });
    expect(res.kind).toBe('unresolvable');
  });
  it('is unresolvable when productionReleasePath is malformed (not one of the 3 shapes)', async () => {
    const { trunkReader } = makeTrunk('h');
    const res = await assembleReleaseProposal({
      deployment: 'acme/widgets', registry: landingFound('tag-and-deploy'), repositories: repos,
      ledgerReader: { lastReleasedMarker: async () => undefined }, trunkReader,
    });
    expect(res.kind).toBe('unresolvable');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @auto-claude/daemon test release/proposal`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `release/types.ts`** with the interfaces above (`re-export DeclaredReleasePath` from `../deployment-registry/types.js`).

- [ ] **Step 4: Implement `release/proposal.ts`.** Narrow `landing` fail-closed exactly like `resolveLandingTarget` (`landing-target.ts:65-70`): `not-found` or not a valid `LandingTarget` → `{ kind: 'unresolvable', reason }`. Validate `productionReleasePath` is one of the three shapes → else `unresolvable`. Read `marker = await ledgerReader.lastReleasedMarker(deployment)`. Resolve `{owner,repo}` from `repositories[0]` and `branch` from `landing.landsOn`. `head = (await trunkReader.getTrunkHead(owner, repo, branch)).sha`. If `marker === head` → `{ kind: 'nothing-to-release' }`. Else `commits = marker ? compareSince(base=marker, head) : listRecent(head)`. Build the structured-safe `summary` (`Release ${deployment}: N change(s) since ${marker ?? 'first release'} → ${head.slice(0,8)}`) and return the proposal.

- [ ] **Step 5: Delete the vestigial module.** `git rm packages/daemon/src/control-plane/release.ts packages/daemon/src/control-plane/release.test.ts`. Grep for imports of `./release.js`; the daemon/server rewire lands in Task 5, so for now stub `handlers.release` to `undefined` in `daemon.ts` and drop the `ReleaseProposalResult` import in `server.ts` (its handler already 501s when `handlers.release` is undefined). Retire `phase0-single-trunk.gate.test.ts` (its premise — `createReleaseProposal` returning `single-trunk-not-applicable` — no longer exists) and remove the `release.ts`-specific assertion from `phase0-halt.gate.test.ts` (keep the rest of that gate).

- [ ] **Step 6: Run the test + typecheck**

Run: `pnpm --filter @auto-claude/daemon test release/proposal && pnpm --filter @auto-claude/daemon typecheck`
Expected: PASS + clean typecheck (no dangling `./release.js` imports).

- [ ] **Step 7: Commit**

```bash
git add -A packages/daemon/src/control-plane
git commit --no-verify -m "feat(release): per-deployment since-last-release proposal assembly (replaces vestigial release.ts)"
```

**Acceptance:** the proposal diffs the deployment's trunk since its derived marker, reports `nothing-to-release` when head==marker, uses `listRecent` on a first release, and fails closed (`unresolvable`) on missing/invalid landing or declared path; the vestigial `release.ts` and its single-trunk gate test are gone with a clean typecheck.

---

## Task 4: The 4th builder — `buildReleaseDecisionRequest` (phase `release`, approve/reject)

**Files:**
- Create: `packages/daemon/src/control-plane/release/build-request.ts`
- Reuse anchors (mirror verbatim except where noted): `merge-decision/build-request.ts:62-134` (`decisionIdFor` + `buildMergeDecisionRequest`, `DecisionRequestSchema.parse` gate, structured-safe context), `revert-lane.ts:78-123` (a sibling approve/reject builder with `phase` a plain string + `risk_class`/`reversibility` literals), `decision-protocol/src/decision-request.ts:23-47` (`DecisionRequestSchema` — `phase` is a free `z.string().min(1)`, `risk_class` ∈ `['P0','P1','P2','P3']`, `reversibility` ∈ `['reversible','hard_to_reverse','external_effect']`)
- Test: `packages/daemon/src/control-plane/release/build-request.test.ts` (pure)

**Interfaces:**
- Consumes: `ReleaseProposal` (Task 3).
- Produces:
```ts
export function releaseDecisionId(deployment: string, targetRevision: string): string; // `release:${deployment}:${targetRevision.slice(0,8)}`
export function buildReleaseDecisionRequest(proposal: ReleaseProposal, opts?: { now?: string; expiresAt?: string; sourceUrl?: string }): DecisionRequest;
```
Consumed by Task 5 (`proposeRelease`).

- [ ] **Step 1: Write the failing test** — `release/build-request.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DecisionRequestSchema } from '@auto-claude/decision-protocol';
import { buildReleaseDecisionRequest, releaseDecisionId } from './build-request.js';
import type { ReleaseProposal } from './types.js';

const proposal: ReleaseProposal = {
  deployment: 'acme/widgets', targetRevision: 'abc123456789', sinceRevision: 'prev0000',
  coveredWork: [{ sha: 'c1', subject: 'add feature', issueNumbers: [12, 14] }],
  declaredPath: { kind: 'platform-performs' },
  summary: 'Release acme/widgets: 1 change since prev0000 → abc12345',
};

describe('buildReleaseDecisionRequest', () => {
  it('parses through the REAL DecisionRequestSchema', () => {
    expect(() => DecisionRequestSchema.parse(buildReleaseDecisionRequest(proposal, { now: '2026-07-03T00:00:00Z' }))).not.toThrow();
  });
  it('is a release-phase approve/reject P0 external-effect decision', () => {
    const r = buildReleaseDecisionRequest(proposal, { now: '2026-07-03T00:00:00Z' });
    expect(r.phase).toBe('release');
    expect(r.risk_class).toBe('P0');
    expect(r.reversibility).toBe('external_effect');
    expect(r.options.map((o) => o.id).sort()).toEqual(['approve', 'reject']);
    expect(r.answer_schema).toEqual({ kind: 'option' });
  });
  it('has a deterministic id == idempotency_key keyed on deployment+target (idempotent re-propose)', () => {
    const a = buildReleaseDecisionRequest(proposal, { now: '2026-07-03T00:00:00Z' });
    const b = buildReleaseDecisionRequest(proposal, { now: '2026-07-03T09:00:00Z' });
    expect(a.decision_id).toBe(releaseDecisionId('acme/widgets', 'abc123456789'));
    expect(a.decision_id).toBe(a.idempotency_key);
    expect(a.decision_id).toBe(b.decision_id); // stable across a later re-propose
  });
  it('carries ONLY structured-safe context — never raw commit bodies', () => {
    const withBody: ReleaseProposal = { ...proposal, coveredWork: [{ sha: 'c1', subject: 'SECRET token=abc; DROP TABLE users;', issueNumbers: [] }] };
    const r = buildReleaseDecisionRequest(withBody, { now: '2026-07-03T00:00:00Z' });
    expect(r.context).not.toContain('DROP TABLE');
    expect(r.context).not.toContain('SECRET token');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @auto-claude/daemon test release/build-request`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `release/build-request.ts`** mirroring `buildMergeDecisionRequest`. `releaseDecisionId = \`release:${deployment}:${targetRevision.slice(0,8)}\``. Structured-safe context assembled from counts + issue numbers ONLY (never `commit.subject` verbatim — subjects may carry arbitrary worker output):

```ts
const issueNumbers = [...new Set(proposal.coveredWork.flatMap((c) => c.issueNumbers))].sort((a, b) => a - b);
const context = [
  `Production-release decision for deployment "${proposal.deployment}".`,
  `Releasing ${proposal.coveredWork.length} accepted change(s) to target ${proposal.targetRevision.slice(0, 8)} since ${proposal.sinceRevision?.slice(0, 8) ?? '(first release)'}.`,
  `Covered issues: ${issueNumbers.length ? issueNumbers.map((n) => `#${n}`).join(', ') : '(none referenced)'}.`,
  `Declared release path: ${proposal.declaredPath.kind}.`,
].join(' ');
const id = releaseDecisionId(proposal.deployment, proposal.targetRevision);
return DecisionRequestSchema.parse({
  decision_id: id, idempotency_key: id,
  source_url: opts?.sourceUrl ?? `https://github.com/${proposal.deployment}`,
  deployment: proposal.deployment, run_id: `release:${proposal.deployment}`,
  worker_session_id: `release-${proposal.deployment}`, phase: 'release',
  risk_class: 'P0', reversibility: 'external_effect',
  question: `Approve the production release for "${proposal.deployment}"?`, context,
  options: [
    { id: 'approve', label: 'Approve the production release and carry out the declared path.' },
    { id: 'reject', label: 'Reject; production is left unchanged.' },
  ],
  consequence_of_no_answer: 'No production release happens; the deployment stays on its last release.',
  expires_at: opts?.expiresAt ?? new Date(new Date(opts?.now ?? new Date().toISOString()).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  answer_schema: { kind: 'option' }, resume_mode: 'requeue',
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @auto-claude/daemon test release/build-request`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/control-plane/release
git commit --no-verify -m "feat(release): buildReleaseDecisionRequest — 4th builder (phase release, P0, approve/reject)"
```

**Acceptance:** the built request parses through the real `DecisionRequestSchema`; `phase==='release'`, `risk_class==='P0'`, `reversibility==='external_effect'`, options are exactly approve/reject; `decision_id===idempotency_key===release:<deployment>:<sha8>` and is stable across a later re-propose; context excludes raw commit subjects/bodies.

---

## Task 5: The 3-shape executor + manager + always-raises policy gate

**Files:**
- Create: `packages/daemon/src/control-plane/release/release-ledger-manager.ts`, `packages/daemon/src/control-plane/release/executor.ts`, `packages/daemon/src/control-plane/release/resolve-consumer.ts`, `packages/daemon/src/control-plane/decision-escalation/sanitize-request.ts` (shared sanitizer extraction)
- Modify: `phases.ts:228-252` (delegate the `sanitizeDecisionRequest` closure to `applyDecisionSanitization`), `daemon.ts:38,2123-2133` (wire `handlers.release`/`previewRelease`/`recordCompletion` per-deployment; construct `ReleaseLedgerManager`, `TrunkReader`, `PromotionPort`, `sanitize`, `readAnswer`; add the `resolveAnsweredReleases` sweep), `server.ts:5,38,205-215` (per-deployment `POST /release`, `POST /release/preview`, `POST /release/completion` routes reading the body)
- Reuse anchors: `phases.ts:2520-2567` (the governed raise→publish→notify SEQUENCE to mirror — including the `posted:false` "stay parked / retry" branch at `:2557-2560`), `phases.ts:228-252` (the sanitize body to extract), `decision-escalation/manager.ts:40-125` (`DecisionIndexManager` `#broken`/`init()`/`ledger()` fail-closed to mirror), `decision-escalation/manager.ts:179` (`withGovernedDecisionMarking`), `decision-escalation/github-block-notifier.ts:180` (`PublishResult.posted` — `posted:false` = fail-closed retry state), `decision-escalation/resume-consumer.ts:82` (`parseCockpitAnswer` — the authoritative-answer reader), `finding-dismissal/apply-consumer.ts` (per-tick answered-decision consumer precedent), `daemon.ts:2790-2867` (`resumeParkedRuns` — the answered-decision→action loop to sibling), `scripts/release.sh:62-71` (platform-performs rollback pattern to model)
- Test: `packages/daemon/src/control-plane/release/executor.test.ts`, `release/release-ledger-manager.test.ts`, `release/resolve-consumer.test.ts` (pure — fake ledger writer, spy `PromotionPort`, spy publisher, fake `decisionManager`, fake `readAnswer`/`sanitize`)

**Interfaces:**
- Consumes: Task 1 `DeclaredReleasePath`, Task 2 `ReleaseLedgerWriter`, Task 3 `assembleReleaseProposal`/`PreviewResult`/`TrunkReader`, Task 4 `buildReleaseDecisionRequest`, the shared `applyDecisionSanitization` (this task, Step 1), and `parseCockpitAnswer` (`decision-escalation/resume-consumer.ts:82`) for the injected `readAnswer`.
- Produces:
```ts
export interface PromotionPort {
  promote(a: { deployment: string; targetRevision: string }): Promise<void>;      // platform-performs; throws on failure
  rollback(a: { deployment: string; toRevision: string | undefined }): Promise<void>;
  fireTrigger(a: { deployment: string; trigger: string; targetRevision: string }): Promise<void>; // trigger-automated; throws if it cannot fire
}
export interface ReleaseLaneDeps {
  registry: ...; repositoriesFor(deployment: string): { owner: string; name: string }[];
  ledger: ReleaseLedgerWriter; trunkReader: TrunkReader; promotion: PromotionPort;
  decisionManager: /* DecisionIndexManager — used for ledger().raise/notify/answer/advanceToResumed/statusOf + withGovernedDecisionMarking + markRuntimeDegradedIfGoverned */;
  publisher: GitHubBlockPublisher;
  sanitize: (req: DecisionRequest) => Promise<DecisionRequest>; // = applyDecisionSanitization(pipeline, req)
  readAnswer: (deployment: string, decisionId: string, issueNumber: number) => Promise<'approve' | 'reject' | undefined>; // verified answer via parseCockpitAnswer over the decision issue comments
  octokit: Octokit; issueNumberFor(deployment: string): number; // the deployment's release-decision issue (config or created on first propose)
}
// releaseId === decision_id === release:<deployment>:<targetSha8> (the two ledgers are linked by this key).
export type ProposeResult =
  | { kind: 'raised'; decisionId: string }        // proposal appended + decision raised AND posted
  | { kind: 'nothing-to-release' }
  | { kind: 'unresolvable'; reason: string }       // missing/invalid landing or declared path — nothing raised
  | { kind: 'degraded'; reason: string };          // ledger unavailable OR published.posted===false — deployment marked degraded; retry next tick
export type ResolveResult =
  | { kind: 'executed'; outcome: ReleaseOutcome }  // approved + a shape carried out (this tick)
  | { kind: 'rejected' }                            // decision event only; production untouched
  | { kind: 'pending' }                             // no verified terminal answer yet — no-op this tick
  | { kind: 'already-resolved' }                    // this release was already decided/executed — replay no-op (idempotent)
  | { kind: 'unresolvable'; reason: string }        // approved but the ORIGINAL proposal/declared path is missing/invalid — refused, surfaced, no execution event
  | { kind: 'degraded'; reason: string };           // Release Ledger unavailable — refused (a release that cannot be recorded must not proceed)
export interface ReleaseLane {
  previewRelease(deployment: string): Promise<PreviewResult>;
  proposeRelease(deployment: string): Promise<ProposeResult>;
  // Resumable + crash-safe + drift-safe: a release is "done" ONLY once a terminal `resolved` event exists
  // (NOT merely a decision/execution event — that would strand a crash-in-flight release); loads the ORIGINAL
  // proposal event by releaseId (executes the APPROVED target/path, never re-derived from current trunk/registry);
  // brackets each production side effect with an `attempt` marker and fails closed on an interrupted attempt
  // (never re-fires an external_effect); reads the VERIFIED answer; then terminalizes the Decision Ledger and
  // appends the `resolved` ack. Ensures the decision is raised (idempotent) so a propose-then-crash still resolves.
  resolveRelease(deployment: string, decisionId: string): Promise<ResolveResult>;
  recordCompletion(deployment: string, releaseId: string, outcome: 'released' | 'failed'): Promise<'applied' | 'already-terminal'>;
}
export function createReleaseLane(deps: ReleaseLaneDeps): ReleaseLane;

// resolve-consumer.ts — the approval→execution path, run each daemon tick (mirrors finding-dismissal/apply-consumer.ts):
// Enumerates pending releases from the Release Ledger (self-contained), not decision-index phase filtering.
export function resolveAnsweredReleases(deps: {
  lane: ReleaseLane;
  reader: Pick<ReleaseLedgerReader, 'openReleases'>; // every release not yet terminally `resolved` (crash-stranded ones included)
}): Promise<void>;
```

- [ ] **Step 1: Extract the shared sanitizer.** Create `decision-escalation/sanitize-request.ts` exporting `applyDecisionSanitization(pipeline: SanitizationPipeline, req: DecisionRequest): Promise<DecisionRequest>` — move the body of the `phases.ts:228-252` closure verbatim (the `pipeline.isEmpty` fast-path + the 4-field `pipeline.run({content, deploymentRef: req.deployment, subjectRef: req.decision_id})` map). Change `phases.ts`'s `sanitizeDecisionRequest` closure to `return applyDecisionSanitization(pipeline, request);`. Run `pnpm --filter @auto-claude/daemon test phases sanitiz` — the existing phases sanitization tests must still pass (pure refactor, zero behavior change).

- [ ] **Step 2: Write the failing manager test** — `release/release-ledger-manager.test.ts` (mirror `DecisionIndexManager` fail-closed): enabled + throwing opener → `isAvailable()===false` and `ledger()` throws `/unavailable/`; disabled → `ledger()` throws `/disabled/`.

- [ ] **Step 3: Implement `release-ledger-manager.ts`** mirroring `DecisionIndexManager` (`#broken`, `init()` that calls `createReleaseLedger` and sets `#broken` on any error without throwing, `ledger()` fail-closed, `close()`), injectable `opener` (defaults to `createReleaseLedger`) so tests inject a throwing stub.

- [ ] **Step 4: Write the failing executor test** — `release/executor.test.ts`. Cover every property below with fakes (no DB, no GitHub). The fake `readAnswer` returns the verified answer; the fake `publisher.ensure` returns `{posted}`; a spy `sanitize` proves it is called:

```ts
// preview never mutates
it('previewRelease never calls the PromotionPort and appends no ledger event', async () => { /* spy.promote never called; ledger has NO rows */ });

// propose: always raises, sanitizes, and fails closed on posted:false
it('proposeRelease ALWAYS raises even at max earned autonomy (no auto-resolve path)', async () => {
  // decisionManager fake reports auto-merge autonomy; assert sanitize + ledger.raise + publisher.ensure called and NO answer auto-applied; returns {kind:'raised'}
});
it('proposeRelease runs the injected sanitizer before raising', async () => { /* spy sanitize called with the built request */ });
it('proposeRelease appends the proposal event IDEMPOTENTLY — a retry (e.g. after a degraded publish) never creates a second proposal event for the same releaseId', async () => {});
it('proposeRelease returns DEGRADED and MARKS the deployment degraded when publisher.ensure posts false', async () => {
  // publisher.ensure → {posted:false}; assert notify NOT called, markRuntimeDegraded called, result.kind==='degraded'
});
it('proposeRelease returns DEGRADED (+marks degraded) when the Release Ledger is unavailable (append throws)', async () => {});

// resolveRelease reads the VERIFIED answer — an asserted approval cannot bypass
it('resolveRelease is pending (no-op) when readAnswer has no terminal answer yet', async () => {
  // readAnswer → undefined; assert no decision/execution event appended; result.kind==='pending'
});
it('resolveRelease reject (verified) → decision event only, production untouched, then Decision Ledger terminalized (answer+advanceToResumed)', async () => {});

// replay-safety: a per-tick sweep never re-executes an approved release; `resolved` is the ONLY terminal marker
it('resolveRelease with a terminal `resolved` event present is already-resolved (no work, no execution)', async () => {});
it('resolveRelease with an execution event but NO `resolved` event re-runs ONLY terminalize (answer+advanceToResumed) and appends `resolved` — no second execution — even when the Decision Ledger is already statusOf===resumed', async () => {});
it('after a successful approve, resolveRelease calls ledger.answer + ledger.advanceToResumed THEN appends the `resolved` event', async () => {});

// crash-recovery: a resumable state machine, keyed on `resolved` (NOT a coarse "any decision/execution event ⇒ done" guard)
it('resumes execution when a decision(approve) event exists but NO attempt/execution (crash before the side effect) → executes + terminalizes + resolved', async () => {});
it('re-terminalizes ONLY (no second execution) when an execution event exists but no resolved event (crash before terminalize)', async () => {});
it('is already-resolved (no work) when a resolved event exists', async () => {});

// exactly-once external effect: an interrupted attempt is NEVER re-fired
it('with an attempt event but NO terminal execution (crash mid-side-effect) → appends execution FAILED (reason interrupted-outcome-unknown), marks degraded, and NEVER calls promote/fireTrigger again', async () => {});

// propose-then-crash: the sweep re-raises an un-raised decision
it('resolveRelease ensures the decision is raised (idempotent) — a proposal whose decision was never published gets re-raised, not left pending forever', async () => {
  // decision never published (ensureDecisionRaised posts on this call); assert raise/publish invoked; degraded until posted
});

// drift-safety: the APPROVED target AND path are executed, not current registry/trunk
it('resolveRelease executes the ORIGINAL proposal target (stored), NOT a re-derived current-trunk head', async () => {
  // proposal event stored targetRevision='sha-approved'; trunkReader now returns 'sha-newer';
  // assert promotion.promote called with 'sha-approved' and the execution event targetRevision==='sha-approved'
});
it('resolveRelease uses the STORED declared path — a proposal stored record-only calls NO promotion even if the registry now says platform-performs', async () => {
  // proposal event detail.declaredPath={kind:'record-only'}; registry.readDeclaredData now returns platform-performs;
  // assert promote/fireTrigger NEVER called and the execution outcome is recorded-awaiting-human
});
it('resolveRelease is unresolvable when no proposal event exists for the releaseId', async () => {});

// fail-safe: rollback itself throwing still never records released
it('platform-performs where BOTH promote and rollback throw → appends execution FAILED (rollbackFailed:true), marks degraded, never released', async () => {});

// 3-shape outcomes + fail-safe (readAnswer → 'approve')
it('platform-performs success → promote, append execution released, marker advances', async () => {});
it('platform-performs failure → rollback to prior marker, append execution FAILED (never released)', async () => {});
it('trigger-automated fires → append triggered-awaiting (non-final); recordCompletion(released) advances marker', async () => {});
it('trigger-automated cannot fire → append FAILED, error surfaced, nothing promoted', async () => {});
it('record-only → append recorded-awaiting-human, PromotionPort NEVER called', async () => {});

// fail closed
it('resolveRelease (approve) is UNRESOLVABLE when the declared path is missing/invalid — no execution event, no promotion', async () => {});
it('resolveRelease is DEGRADED when the Release Ledger is unavailable — refuses, no production change', async () => {});

// terminal guard
it('recordCompletion on an already-terminal release is a no-op (already-terminal)', async () => {});
```

- [ ] **Step 5: Run to verify the executor tests fail**

Run: `pnpm --filter @auto-claude/daemon test release/executor`
Expected: FAIL — `createReleaseLane` not implemented.

- [ ] **Step 6: Implement `executor.ts`.**
  - `previewRelease` = `assembleReleaseProposal(...)` and return it. No ledger append, no promotion. (Preview = the proposal.)
  - `proposeRelease`: `assembleReleaseProposal`; on `nothing-to-release`/`unresolvable` return as-is; else guard the ledger — if unavailable, `markRuntimeDegradedIfGoverned(decisionManager, deployment, 'release-ledger-unavailable')` and return `{kind:'degraded'}` (a release that cannot be recorded must not proceed). Resolve `const issueNumber = issueNumberFor(deployment);` and append the proposal event **atomically-idempotently** via `await ledger.appendProposalIfAbsent({event:'proposal', releaseId: decisionId, deployment, targetRevision, detail: { ...proposal, issueNumber }})` — the partial unique index guarantees exactly one `proposal` per `releaseId` even under two concurrent `/release` proposes (the second is a no-op, not a divergent duplicate); `releaseId` is keyed on the target sha. **The proposal event is the durable record of the APPROVED target/path/issue** (drift-safe: resolveRelease reads THIS, never current trunk). Then raise via the shared **`const posted = await ensureDecisionRaised(proposal, issueNumber);`** (defined below). **`if (!posted) { markRuntimeDegradedIfGoverned(decisionManager, deployment, 'not-posted'); return { kind: 'degraded', reason: 'not-posted' }; }`** — `posted:false` is the fail-closed retry state (the Operator may not have seen it), so it is NOT `raised` and the deployment is marked degraded per L2 §"Decision transport degraded"; the appended proposal is fine because the raise is idempotent on `decision_id` and the resolve-sweep re-raises. On `posted` → `return { kind: 'raised', decisionId }`. **There is NO auto-resolve branch** — do not copy the merge earn-in path. Any transport throw → `withGovernedDecisionMarking` (inside `ensureDecisionRaised`) marks the deployment degraded → return `{kind:'degraded'}`.
  - `resolveRelease(deployment, decisionId)` — a **resumable, crash-safe state machine** keyed on which Release-Ledger events already exist (NOT a coarse "any decision event ⇒ done" guard, which would strand a release that crashed between decision-append and execution). `releaseId = decisionId`:
    1. **Ledger guard.** Release Ledger unavailable → `markRuntimeDegradedIfGoverned` + return `{kind:'degraded'}`.
    2. **Load the APPROVED proposal (drift-safe).** Read `rows = eventsForRelease(deployment, releaseId)`. Find the `proposal` event; none → `{kind:'unresolvable', reason:'no proposal event'}`. Take `targetRevision`, `declaredPath`, `issueNumber` from THAT stored event — **never re-run `assembleReleaseProposal` and never re-read the registry path on approval** (the trunk may have advanced AND the profile's declared path may have changed; the Operator approved a specific target AND a specific shape).
    3. **Recovery classification (crash-safe, in priority order).**
       - A `resolved` event exists → return `{kind:'already-resolved'}` (Operator decision fully consumed).
       - Else a terminal `execution`/`completion` event exists → the shape already ran; re-run ONLY the terminalize step (step 7) using the answer from the durable `decision` event (`rows.find(e => e.event === 'decision').detail.answer`), then return `{kind:'already-resolved'}` (never re-execute).
       - Else an `attempt` event exists (a production side effect was BEGUN before a crash — its real-world result is UNKNOWN) → **fail closed, never re-fire an external_effect:** `append({event:'execution', targetRevision, detail:{outcome:'failed', reason:'interrupted-outcome-unknown'}})`, `markRuntimeDegradedIfGoverned(decisionManager, deployment, 'release execution interrupted — outcome unknown, operator must verify')`, terminalize (step 7), return `{kind:'executed', outcome:'failed'}`. (The Operator verifies what actually happened and re-proposes if needed. A production release is `external_effect` — the platform must never blind-retry it.)
    4. **Ensure the decision is raised + published (idempotent).** `const posted = await ensureDecisionRaised(proposal, issueNumber);` (see below — the shared raise→publish→notify used by `proposeRelease`; idempotent on `decision_id`). If `!posted` → `markRuntimeDegradedIfGoverned` + return `{kind:'degraded'}` (can't read an answer for an unpublished decision — the sweep re-raises next tick). This closes the "proposal appended but the daemon crashed before the decision was raised" stranding: the sweep re-raises until the Operator can actually see it.
    5. **Determine the answer** — prefer the durable record: `const decisionEvent = rows.find(e => e.event === 'decision');` `const answer = decisionEvent ? decisionEvent.detail.answer : await readAnswer(deployment, decisionId, issueNumber);` — `undefined` (no decision event AND no verified DecisionResponse) → `{kind:'pending'}` (nothing appended). An asserted approval cannot reach here.
    6. **Append the durable decision event, then execute (idempotent-by-existence, side effects outbox-bracketed).** If no `decision` event exists, `append({event:'decision', detail:{answer}})`. On `reject`, skip execution. On `approve`, validate `declaredPath` is one of the 3 stored shapes (else terminalize (step 7) and return `{kind:'unresolvable', reason}`) then per shape (execute from the STORED target/path). **For the two production-mutating shapes, append the `attempt` marker BEFORE the side effect** so step 3 can fail-close on a crash-in-flight:
       - `platform-performs`: `await append({event:'attempt', targetRevision, detail:{shape:'platform-performs'}}); try { await promotion.promote({deployment, targetRevision}); append({event:'execution', targetRevision, detail:{outcome:'released'}}); } catch (promoteErr) { let rollbackFailed = false; try { await promotion.rollback({deployment, toRevision: prevMarker}); } catch { rollbackFailed = true; } append({event:'execution', targetRevision, detail:{outcome:'failed', rollbackFailed}}); markRuntimeDegradedIfGoverned(decisionManager, deployment, rollbackFailed ? 'platform-performs failed AND rollback failed' : 'platform-performs failed'); }` — **never append `released` on failure**; a rollback that itself throws still appends `failed` (`rollbackFailed:true`) + marks degraded (models `scripts/release.sh:62-71`).
       - `trigger-automated`: `await append({event:'attempt', targetRevision, detail:{shape:'trigger-automated'}}); try { await promotion.fireTrigger({deployment, trigger, targetRevision}); append({outcome:'triggered-awaiting'}); } catch { append({outcome:'failed'}); }`.
       - `record-only`: `append({outcome:'recorded-awaiting-human'})`; NO `attempt` (no external effect); NEVER call promotion (even if the CURRENT registry path is now `platform-performs` — the stored `record-only` is authoritative).
    7. **Terminalize the Decision Ledger, then append the `resolved` ack LAST.** `await decisionManager.ledger().answer(decisionId, answer, 'operator'); await decisionManager.ledger().advanceToResumed(decisionId);` (idempotent — mirrors `apply-consumer.ts:287-289` + `resumeParkedRuns` `daemon.ts:2869,3222`) so `pending()` stops returning it; THEN `append({event:'resolved', detail:{answer}})` — the terminal ack that removes this release from `openReleases()`. Fail-closed on any throw: leave `resolved` un-appended so the next sweep re-picks (the durable `execution`/`attempt` state routes step 3 correctly without re-firing). Return `{kind:'rejected'}`, `{kind:'unresolvable', reason}`, or `{kind:'executed', outcome}`.
    - **Crash-recovery coverage (sweep re-picks via `openReleases` until `resolved`), no stranding and no double external effect:** crash after `decision(approve)` before `attempt` → resume (no side effect fired yet) → execute → `resolved`. Crash after `attempt` before/after the side effect but before its `execution` record → step 3 sees `attempt` → fail closed `failed` (never re-fires) → `resolved`. Crash after `execution` before terminalize → terminalize-only → `resolved`. Crash after terminalize before `resolved` → idempotent terminalize no-op → `resolved`. Crash after `proposal` before raise → step 4 re-raises. After `resolved` → dropped.

  - **`ensureDecisionRaised(proposal, issueNumber)`** (shared by `proposeRelease` and `resolveRelease` step 4): mirror `phases.ts:2520-2567` with the primitives + injected sanitizer, idempotent on `decision_id` — `const req = buildReleaseDecisionRequest(proposal); const sanitized = await sanitize(req); const { decision_id } = await withGovernedDecisionMarking(decisionManager, deployment, () => decisionManager.ledger().raise(sanitized)); const published = await publisher.ensure({ request: sanitized, octokit, owner, repo, issueNumber }); if (published.posted) { await withGovernedDecisionMarking(decisionManager, deployment, () => decisionManager.ledger().notify(decision_id)); clearRuntimeDegradedIfGoverned(decisionManager, deployment); } return published.posted;` — `ledger.raise`/`publisher.ensure`/`notify` are all idempotent, so calling this on every sweep is safe. **No auto-resolve branch.**
  - `recordCompletion(deployment, releaseId, outcome)`: read `latestOutcome`; already terminal (`released`/`failed`) → return `'already-terminal'`; only a non-final (`triggered-awaiting`/`recorded-awaiting-human`) may complete → `append({event:'completion', targetRevision, detail:{outcome}})`; return `'applied'`. (`released` advances the marker via Task 2's derivation; `failed` leaves it.)

- [ ] **Step 7: Write the resolve-consumer + its test** — `release/resolve-consumer.ts` + `resolve-consumer.test.ts`. `resolveAnsweredReleases({lane, reader})` reads `reader.openReleases()` (every release with a `proposal` but no terminal `resolved` event — self-contained enumeration from the Release Ledger, NOT decision-index phase filtering; crash-stranded releases are included) and, for each `{deployment, releaseId}`, calls `lane.resolveRelease(deployment, releaseId)` (`decisionId === releaseId`) — the approval→execution path, mirroring `finding-dismissal/apply-consumer.ts`. The lane's injected `readAnswer(deployment, decisionId, issueNumber)` reuses `parseCockpitAnswer(comments, decisionId)` (`decision-escalation/resume-consumer.ts:82`) over the decision issue's comments (the `issueNumber` recorded in the proposal event), so an answer is recognized ONLY from an authoritative DecisionResponse — never an asserted approval. Tests: (a) a release with a verified `approve` DecisionResponse drives execution then is terminal (a second sweep finds it NOT in `openReleases` → not re-picked; no second execution event); (b) one with no DecisionResponse stays `pending` and REMAINS in `openReleases` (re-picked next sweep); (c) **crash-recovery:** a release seeded with a `decision(approve)` event but no `execution`/`resolved` is STILL in `openReleases` and the sweep RESUMES it to execution + `resolved`.

- [ ] **Step 8: Wire the lane into the daemon.** `daemon.ts`: construct a `ReleaseLedgerManager` (enabled when the decision index is enabled; `databaseUrl` from `AUTO_CLAUDE_DATABASE_URL`), an octokit-backed `TrunkReader` (`repos.getBranch`/`repos.compareCommits`/`repos.listCommits`), the injected `sanitize` (= `(req) => applyDecisionSanitization(pipeline, req)` with the deployment's pipeline), the injected `readAnswer` (= `parseCockpitAnswer` over the decision issue comments), and a `PromotionPort` whose `platform-performs` impl shells the `scripts/release.sh` promotion (guarded, Operator-drill only) and whose `trigger-automated` impl dispatches the declared `trigger`. **The `trigger-automated` dispatch MUST apply the same SSRF + DNS-rebinding guards the existing deploy path uses** — `validateHealthCheckUrl` + `validateHealthCheckResolvedIP` (`validation/deploy.ts:120-160,92-115`) — before it fires, treating the `trigger` string as an untrusted URL/target; a guard rejection is a `fireTrigger` throw (→ `execution failed`, nothing promoted). (The concrete dispatch shape — GitHub `workflow_dispatch` vs webhook POST vs shell command — is DEFERRED; see "Deferred" below. This code unit validates + throws on an unsafe target but does not pin the transport.) Change `ControlHandlers.release` (`server.ts:38`) to **`release?: (deployment: string) => Promise<ProposeResult>`** and add **`previewRelease?: (deployment: string) => Promise<PreviewResult>`**; the `POST /release` and `POST /release/preview` routes read the deployment id from the JSON body (`{deployment}`) — the Operator names the registry key (`owner/repo`). Wire `handlers.release = (d) => lane.proposeRelease(d)` and `handlers.previewRelease = (d) => lane.previewRelease(d)` (`daemon.ts:2123`); drop the `ReleaseProposalResult` import (`server.ts:5`). Add the `resolveAnsweredReleases({lane, reader: releaseLedger.reader()})` sweep to the per-tick loop next to `resumeParkedRuns` (this is the wired approval→execution path; it enumerates OPEN releases from the Release Ledger — including crash-stranded decision-only / executed-not-terminalized ones — and is idempotent per tick; the actual LIVE promotion side effect stays Operator-gated per Global Constraints). Add a concrete report-back entrypoint for handed-off releases (L2 `recordCompletion`): `ControlHandlers.recordCompletion?: (deployment: string, releaseId: string, outcome: 'released' | 'failed') => Promise<{ result: 'applied' | 'already-terminal' }>` wired to `lane.recordCompletion`, exposed as `POST /release/completion` reading `{deployment, releaseId, outcome}` from the body. This is the **explicitly-invoked** operation by which a handed-off (`triggered-awaiting`/`recorded-awaiting-human`) release is resolved to `released`/`failed` and (on `released`) the Last-Released Marker advances. **What is DEFERRED (see "Deferred" below): the AUTO-trigger** — WHO/WHAT calls `recordCompletion` (an automation callback, platform polling, or an Operator manual-mark). This code unit builds only the callable operation + the `completion` event; it invents no polling or callback mechanism (the L1 does not specify one).

- [ ] **Step 9: Run the executor + manager + consumer tests + daemon typecheck**

Run: `pnpm --filter @auto-claude/daemon test release/ && pnpm --filter @auto-claude/daemon typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 10: Commit**

```bash
git add -A packages/daemon/src/control-plane
git commit --no-verify -m "feat(release): 3-shape executor + verified-answer resolve consumer + always-raises fail-safe (release lane)"
```

**Acceptance:** preview never touches production or the ledger; `proposeRelease` always raises (no auto-resolve path) even at max autonomy, runs the injected sanitizer, records the approved target in the proposal event, and returns `degraded` — **and marks the deployment degraded** — when the ledger is unavailable OR `published.posted` is false; `resolveRelease` acts ONLY on a verified Decision-Ledger answer (an asserted approval cannot bypass), is `pending` with no answer, `already-resolved` ONLY once a terminal `resolved` event exists (a decision/execution-only release is RESUMED, not skipped), executes the ORIGINAL stored proposal target/path (drift-safe, never re-derived from current trunk/registry), brackets each production side effect with an `attempt` marker and fails closed (records `failed`, never re-fires) on an interrupted attempt, is `unresolvable` on a missing proposal/declared path, `degraded` when the ledger is unavailable or the decision cannot be (re-)raised, and terminalizes the Decision Ledger then appends `resolved` after the durable events; every shape produces its correct outcome with the fail-safe (platform-performs failure rolls back + records `failed`, never `released`; a throwing rollback still records `failed`); record-only never touches production; `recordCompletion` is a no-op on an already-terminal release; the resolve-consumer drives execution EXACTLY once (no double external effect) from a verified answer, re-picking crash-stranded releases via `openReleases` until `resolved`.

---

## Task 6: Traceability, spec code_paths, docs

**Files:**
- Modify: `.specify/traceability.yml` (STACK-AC-RELEASE `code_paths`), `.specify/stack/release-ts.md` (add net-new `code_paths` for files that now exist)
- Reuse anchor: memory `l3_traceability_codepaths_must_exist` — CI fails if `code_paths` point to missing files; only add paths for files created by Tasks 1-5.

- [ ] **Step 1: Run the traceability check to see current state**

Run: `pnpm --filter @auto-claude/daemon test traceability 2>/dev/null || node .specify/scripts/check-traceability.* 2>/dev/null; echo "check whichever exists"`
Expected: currently GREEN with only `scripts/release.sh` + `scripts/test-release-dry-run.sh`.

- [ ] **Step 2: Add the net-new code_paths** to `STACK-AC-RELEASE` in `.specify/traceability.yml` and the L3 front-matter `code_paths` — ONLY paths that now exist:
```
    - scripts/release.sh
    - packages/release-ledger/src/schema.ts
    - packages/release-ledger/src/ledger.ts
    - packages/daemon/src/control-plane/deployment-registry/schema.ts
    - packages/daemon/src/control-plane/release/proposal.ts
    - packages/daemon/src/control-plane/release/build-request.ts
    - packages/daemon/src/control-plane/release/executor.ts
    - packages/daemon/src/control-plane/release/release-ledger-manager.ts
```
Keep `status: approved` on **FUNC-AC-RELEASE** (L1 is Operator-approved — frontmatter `status: approved`, `.specify/functional/release.md:5`) and `status: draft` on **ARCH-AC-RELEASE** and **STACK-AC-RELEASE** (L2/L3 stay draft pending the Phase-9 live proof, per the L1 header note and memory `ac_production_plan_2026_07`). Do NOT downgrade L1.

- [ ] **Step 3: Run the traceability check to verify green**

Run: (same as Step 1)
Expected: GREEN — every listed `code_path` exists.

- [ ] **Step 4: Commit**

```bash
git add .specify/traceability.yml .specify/stack/release-ts.md
git commit --no-verify -m "docs(release): trace the release-lane code_paths (specs stay draft pending live proof)"
```

**Acceptance:** traceability is green with the net-new lane files traced; L1 stays `approved`, L2/L3 stay `draft`.

---

## Deferred (pending Operator L1-clarification)

The spec author surfaced three areas the approved L1 leaves under-specified. This code unit builds the **generic seam** for each and DEFERS the concrete mechanism as a documented, non-blocking follow-up (each pending an Operator L1-clarification). **The acceptance gate MUST NOT assert behavior for any deferred concrete mechanism below** — only the generic seam.

1. **Completion signal for handed-off releases.** BUILD: `recordCompletion` as a callable operation + `POST /release/completion` route + the `completion` ledger event, so a `triggered-awaiting`/`recorded-awaiting-human` release CAN be resolved to `released`/`failed` and the Last-Released Marker advances (Task 5). DEFER: the AUTO-trigger — whether an automation callback, platform polling, or an Operator manual-mark invokes it. For this unit `recordCompletion` is invoked **explicitly** (Operator/API action); no polling/callback mechanism is invented (the L1 specifies none).
2. **`platform-performs` parameters.** BUILD: `{kind:'platform-performs'}` **param-less** — honest for the platform's own deployment (the `scripts/release.sh` promotion). DEFER: any promote-command/target for **non-platform** deployments; the discriminated union is extensible, so a future shape/field is additive. (Task 1.)
3. **`trigger-automated` dispatch.** BUILD: `trigger` as an opaque **validated** string; the executor MUST apply the existing deploy path's SSRF + DNS-rebinding guards (`validateHealthCheckUrl` + `validateHealthCheckResolvedIP`, `validation/deploy.ts:120-160,92-115`) to the target before firing, throwing (→ `execution failed`, nothing promoted) on rejection (Task 5). DEFER: the concrete dispatch shape — GitHub `workflow_dispatch` vs webhook POST vs shell command. The guard is required now; the transport is a follow-up.

These belong in a short deferred-decisions note / L1-clarification ask to the Operator; they do not block this code unit.

## Immovable Acceptance-Gate Spec (CONDUCTOR input for the RED gate)

The gate is a suite of 24 concrete tests that MUST be RED before Tasks 1-5 land and GREEN after. Each asserts a spec property that would falsify a broken implementation. Grouped by the store they need.

### Pure (no database — fake ledger writer/reader, spy ports, injected stubs)

1. **Union schema** (`DeploymentProfileSchema`) — accepts each of `{kind:'platform-performs'}`, `{kind:'trigger-automated',trigger}`, `{kind:'record-only',procedure}`; **rejects** a bare string, a missing discriminant field (`trigger`/`procedure`), an unknown `kind`, and extra keys (`.strict()`). *Falsifies:* reverting to `z.string().min(1)`, or a non-strict/loose union.
2. **Builder shape** — `buildReleaseDecisionRequest(proposal)` parses through the REAL `DecisionRequestSchema`; `phase==='release'`; `risk_class==='P0'`; `reversibility==='external_effect'`; options exactly `{approve,reject}`; `answer_schema==={kind:'option'}`. *Falsifies:* wrong phase/risk/options.
3. **Builder determinism/idempotency** — `decision_id===idempotency_key===release:<deployment>:<targetSha8>` and is identical for a later re-propose of the same target with a different clock. *Falsifies:* time- or nonce-based ids (a retried propose would duplicate the decision).
4. **Builder context safety** — a proposal whose covered commit subject contains `DROP TABLE`/`SECRET token=…` produces a request whose `context`/`question` contain neither. *Falsifies:* interpolating raw commit subjects/bodies into the decision.
5. **Always-raises / never-earns-autonomy** — with a `decisionManager` fake reporting maximum earned autonomy (auto-merge), `proposeRelease` STILL calls `sanitize` + `ledger.raise` + `publisher.ensure` and applies NO answer; assert no auto-resolve/auto-approve occurs. *Falsifies:* routing `phase:'release'` through merge earn-in / auto-approve.
6. **Preview never mutates** — `previewRelease` returns a proposal, the spy `PromotionPort` is NEVER called, and NO ledger event is appended. *Falsifies:* any production side-effect (or ledger write) during preview.
7. **Executor — platform-performs success** — `promote` resolves → an `execution` event with outcome `released` is appended after promote, and `rollback` is not called. *Falsifies:* recording `released` before/without a confirmed promotion.
8. **Executor — platform-performs fail-safe (incl. rollback-throws)** — `promote` throws → `rollback({toRevision: priorMarker})` is called AND an `execution` event with outcome `failed` (never `released`) is appended; and when `rollback` ALSO throws, an `execution` `failed` event (with `rollbackFailed:true`) is still appended, the deployment is marked degraded, and NO `released` is ever recorded. *Falsifies:* leaving production half-promoted, recording `released` on failure, or crashing/omitting the record when rollback fails.
9. **Executor — trigger-automated fires** — `fireTrigger` resolves → an `execution` event `triggered-awaiting` (non-final) is appended and `promote` is never called. *Falsifies:* treating a trigger as an immediate `released`.
10. **Executor — trigger-automated cannot fire** — `fireTrigger` throws → an `execution` event `failed` is appended, nothing is promoted. *Falsifies:* silently marking triggered on a failed dispatch.
11. **Executor — record-only** — an `execution` event `recorded-awaiting-human` is appended and the `PromotionPort` (promote/fireTrigger) is NEVER called. *Falsifies:* touching production for a record-only deployment.
12. **Executor — reject (verified)** — with `readAnswer → 'reject'`, `resolveRelease` appends a `decision` event only, returns `{kind:'rejected'}`; no `execution` event; no promotion call. *Falsifies:* executing on a reject.
13. **Declared-path fail-closed (typed)** — a deployment whose `productionReleasePath` is missing/invalid → `resolveRelease` (verified approve) returns `{kind:'unresolvable', reason}`, appends NO `execution` event, calls no promotion (mirrors `resolveLandingTarget` escalate — "refuses and surfaces why"). *Falsifies:* guessing a shape, or refusing silently with no surfaced reason.
14. **recordCompletion terminal guard** — completing an already-`released`/`failed` release returns `already-terminal` and appends no event; only `triggered-awaiting`/`recorded-awaiting-human` may be completed. *Falsifies:* rewriting a terminal release.
15. **Manager fail-closed init + ledger-unavailable refuse** — a `ReleaseLedgerManager` with a throwing opener is `#broken` (`isAvailable()===false`, `ledger()` throws `/unavailable/`); `proposeRelease` returns `{kind:'degraded'}` and `resolveRelease` returns `{kind:'degraded'}` (neither proceeds) when the ledger is unavailable, and each calls `markRuntimeDegradedIfGoverned`. *Falsifies:* proceeding on an unrecordable release, or failing without marking degraded.
16. **Proposal fail-closed + since-diff source + nothing-to-release** — `assembleReleaseProposal` returns `unresolvable` on missing/invalid landing OR a malformed (non-3-shape) `productionReleasePath`; returns `nothing-to-release` when trunk head equals the derived marker; and, when a marker exists, calls `compareSince(base=marker, head)` (NOT `listRecent`) and the proposal's `coveredWork` equals the `compareSince` set (the two fakes return DISTINCT sets). *Falsifies:* proposing an empty release, guessing on missing landing, OR always diffing recent commits instead of since-the-marker.
17. **Decision-transport degraded is fail-closed + marked** — with `publisher.ensure → {posted:false}`, `proposeRelease` returns `{kind:'degraded'}` (NOT `raised`), does NOT call `ledger.notify`, AND calls `markRuntimeDegradedIfGoverned(deployment)` (L2 §"Decision transport degraded"). *Falsifies:* reporting a release raised when the Operator may never see it, or degrading silently without marking.
18. **resolveRelease acts only on a VERIFIED answer** — with `readAnswer → undefined` (no authoritative DecisionResponse), `resolveRelease` returns `{kind:'pending'}` and appends NO decision/execution event and calls no promotion; execution happens only when `readAnswer` returns a terminal `approve`/`reject`. The resolve-consumer's `readAnswer` is `parseCockpitAnswer` over the decision issue's comments. *Falsifies:* accepting an asserted approval (a caller-supplied boolean) to drive a release, bypassing the Operator's recorded answer.
19. **Exactly-once execution + crash-recovery (incl. the SWEEP) + terminalization** — (a) after a verified `approve` drives one execution, a second `resolveRelease` for the same `decisionId` returns `{kind:'already-resolved'}` and appends NO second execution event; (b) a `decision(approve)`-only release (crash before the side effect) RESUMES to execution + `resolved`; (c) an executed-but-not-`resolved` release re-runs ONLY terminalize (no second execution); (d) **interrupted external effect — exactly-once:** a release with an `attempt` event but NO terminal `execution` (crash mid-side-effect) is recovered by appending `execution failed` (reason `interrupted-outcome-unknown`) + marking degraded, and `promote`/`fireTrigger` is NEVER called a second time; (e) a successful resolve calls `ledger.answer` then `ledger.advanceToResumed` then appends `resolved`; (f) **through the SWEEP:** `resolveAnsweredReleases` re-picks decision-only / executed-not-`resolved` / attempt-interrupted releases via `openReleases()` and drives each to `resolved` — dropped ONLY after `resolved`. *Falsifies:* a coarse "any decision/execution event ⇒ done" guard, a consumer enumeration that strands a decision-only release, a per-tick sweep re-executing (re-firing the external effect of) an approved release, or never terminalizing.
20. **Drift-safety — the APPROVED target AND path are executed** — (a) the proposal event stored `targetRevision='sha-approved'`; the `trunkReader` now returns a newer head `sha-newer`; `resolveRelease` (verified approve) calls `promotion.promote({targetRevision:'sha-approved'})` and appends an execution event with `targetRevision==='sha-approved'` — NOT `sha-newer`; (b) the proposal event stored `declaredPath={kind:'record-only'}` but the registry now returns `platform-performs`; `resolveRelease` uses the STORED `record-only` and calls NO promotion (outcome `recorded-awaiting-human`); (c) a missing proposal event → `{kind:'unresolvable'}`. *Falsifies:* re-deriving the target from current trunk OR the path from the current registry on approval (releasing unapproved work, or turning an approved record-only release into a production-mutating one).

### PGlite (in-memory real Postgres — `test/helpers/temp-db.ts`; the Release Ledger store)

21. **Ledger append-only + end-to-end read** — appending `proposal → decision → execution` for a `release_id` reads back those events in append order. *Falsifies:* mutation/reordering; a mutable per-release row.
22. **Last-Released Marker derivation** — marker is the most recent `released` event's `target_revision`; does NOT advance on `triggered-awaiting`/`recorded-awaiting-human`/`failed`; a `completion(released)` advances it; `undefined` for a never-released deployment. *Falsifies:* storing the marker separately, or advancing on a non-final/failed outcome.
23. **openReleases enumeration (crash-safe)** — a release with a `proposal` event appears in `openReleases()` (with its `detail`); it STILL appears after a `decision` event is appended (crash-stranded — must be re-picked); it disappears only once a terminal `resolved` event is appended. *Falsifies:* an enumeration that drops a decision-only or executed-not-terminalized release (stranding it), or one that keeps re-picking a fully-`resolved` release.
24. **Atomic single-proposal-per-release** — proposing the same `deployment`+target twice (sequentially AND concurrently) appends exactly ONE `proposal` row for that `releaseId`: `appendProposalIfAbsent` inserts once and the partial unique index rejects the second at commit (no read-then-append race). *Falsifies:* a non-atomic read-then-append that lets a retry or two concurrent proposes record a second, ambiguous proposal for the same `releaseId`. (Runs on PGlite against the real index.)

**Not re-tested here (inherited):** the store's cross-process single-writer guarantee comes verbatim from the ported `db.ts` advisory-lock primitive already proven by `decision-index`'s `cross-process-writer.pg.test.ts`; the release-ledger reuses that primitive and needs no new DB_URL-gated suite.

---

## Definition of Done

- The acceptance gate (all 24 criteria) is GREEN.
- `pnpm --filter @auto-claude/daemon test` and `pnpm --filter @auto-claude/release-ledger test`: no new failures vs `main`.
- `pnpm --filter @auto-claude/daemon typecheck`, repo lint, and the traceability check: green.
- PR opened to `main` (visibility per the autonomous branch model).
- The **LIVE release drill** — actually promoting a real deployment's production through a shape — is Operator-gated and explicitly OUT of this code unit (mirrors P2's Phase-9 carve-out). This unit proves the lane against injectable ports + fakes; the real `launchctl`/`git`/trigger side effects are wired but proven live only under Operator gate.

## Self-Review

- **Spec coverage:** L1 scenarios → Tasks: preview-before-change (T3/T5 #6), approval-only production change (T5 resolveRelease approve, verified answer #18, drift-safe approved-target #20), nothing-without-approval (T5 always-raises #5 + verified-answer #18 + replay-idempotency #19), failed-release-leaves-prod-intact (T5 #8), every-release-recorded (T2 ledger + T5 execution events), per-deployment aggregation (T3) + per-deployment surface (T5 Step 8), always-raises/never-earns-autonomy (T4 phase + T5 #5), declared-path 3 shapes on approval (T1 + T5), record-only changes nothing (T5 #11), auditable end-to-end (T2 #21 + T5). L2 API previewRelease/proposeRelease/resolveRelease/recordCompletion → T5, with the approval→execution path via the resolve-consumer (T5 Step 7, enumerated by `openReleases` #23, exactly-once via the `attempt`/`resolved` outbox markers). L2 error handling (nothing-to-release, missing/malformed path, platform-performs fail incl. rollback-throws, trigger cannot fire, handed-off failure, ledger unavailable, decision-transport degraded+marked, interrupted-attempt fail-closed, autonomy bypass) → gate criteria 5,8,10,13,15,16,17,18,19,20,24 + T5. L3 five pieces → T1 (union), T2 (ledger), T3 (proposal), T4 (builder), T5 (executor + verified-answer/idempotent/drift-safe resolve-consumer + shared sanitizer). No spec requirement is left without a task.
- **Placeholder scan:** every code step shows real code or a concrete file:line reuse anchor; no TBD/TODO.
- **Type consistency:** `DeclaredReleasePath` (T1) is consumed by `ReleaseProposal.declaredPath` (T3) and read by the executor (T5); `ReleaseProposal` (T3) is consumed by `buildReleaseDecisionRequest` (T4) and `proposeRelease` (T5); `ReleaseLedgerWriter`/`ReleaseOutcome` (T2) are consumed by T5; `ReleaseEventKind`/outcome literals match across T2, T5, and the gate.
