# Concierge Phase 0 — Amendments v2 (after Codex iter 2)

This file supersedes `2026-05-01-concierge-phase-0-amendments.md` for the items it touches. Apply v1 plan + v1 amendments + this file in order during execution. Items not mentioned here remain as in v1 plan / v1 amendments.

Codex iter 2 findings: 3 L1 nits, Task 14 traceability still incomplete, Task 15 fixture rename missed, Task 24 / Definition of Done conflict with amended Task 23, plus L2/L3 layer-purity flags (deferred to Phase 0.5; see end of this file).

---

## L1 nits — three single-line fixes

### FUNC-CONCIERGE-MEMORY

In the **Out of Scope** section, replace:

```
- Vector / embedding-based recall as the primary mechanism.
```

with:

```
- Automated recall beyond explicit durable records and recent activity.
```

### FUNC-CONCIERGE-BOARD

In the **Boundary** section, replace:

```
The auto-claude operator dashboard (governed by `FUNC-AC-DASHBOARD`) remains the deep-control surface for the auto-claude subsystem (configuration, run history, cost reports). The triage surface defined here is the at-a-glance cross-subsystem surface for items that need attention or are in flight. The two surfaces have distinct scopes; they may cross-link, but they share no governing data and have no overlapping responsibilities.
```

with:

```
A separate deep-control surface remains responsible for configuration, history, and administrative views. The triage surface defined here is the at-a-glance, cross-domain surface for items that need attention or are in flight. The two surfaces have distinct scopes; they may cross-link, but share no governing data and have no overlapping responsibilities.
```

### FUNC-OBSERVER (six replacements)

1. Problem Statement — replace:
   - **From:** `The operator runs other tools, edits work, makes commits — sometimes in parallel with the assistant's own activity.`
   - **To:** `The operator performs work outside the assistant, sometimes in parallel with the assistant's own activity.`

2. Actors — replace:
   - **From:** `Activity — a discrete occurrence the operator might care about (a new branch, a new commit, a status change in a long-running system the assistant collaborates with).`
   - **To:** `Activity — a discrete occurrence the operator might care about, such as a new unit of work, a completed change, or a status change in ongoing work.`

3. Watch scope — Observer starts scenario:
   - **From:** `Then it adopts the configured allow-list of work areas to watch and the ignore-list of paths to drop within them`
   - **To:** `Then it adopts the operator-approved observation scope and the categories of activity to exclude.`

4. Privacy — sensitive-pattern scenario:
   - **From:** `Given a path matching a sensitive-pattern (e.g., environment files, secret stores) changes within a watched area`
   - **To:** `Given activity belongs to a sensitive excluded category`

5. Constraints — write-only constraint:
   - **From:** `never mutates the filesystem or any external system.`
   - **To:** `never changes anything outside itself.`

6. Success Criterion item 4:
   - **From:** `An observer process restart loses at most one polling interval of cached state.`
   - **To:** `A restart loses at most the most recent unsaved activity.`

---

## Task 14 — traceability fix (was incomplete)

V1 amendments updated only `STACK-CONCIERGE-BOARD`'s frontmatter `references:`. The traceability.yml entry is still:

```yaml
STACK-CONCIERGE-BOARD:
  parent: FUNC-CONCIERGE-BOARD     # L3 → L1: violates layer contract
  ...
```

Replace inside Task 15's traceability.yml additions:

```yaml
STACK-CONCIERGE-BOARD:
  parent: ARCH-CONCIERGE-RUNTIME
  children: []
  code_paths:
    - packages/concierge/src/board/
  test_paths:
    - packages/concierge/src/board/**/*.test.ts
  status: draft
```

And remove `STACK-CONCIERGE-BOARD` from the children list of `FUNC-CONCIERGE-BOARD` in traceability:

```yaml
FUNC-CONCIERGE-BOARD:
  children: [ARCH-CONCIERGE-RUNTIME, ARCH-EVENT-BUS]   # was: [ARCH-CONCIERGE-RUNTIME, ARCH-EVENT-BUS, STACK-CONCIERGE-BOARD]
  related: [FUNC-AC-DASHBOARD]
  status: draft
```

Add `STACK-CONCIERGE-BOARD` as a child of `ARCH-CONCIERGE-RUNTIME`:

```yaml
ARCH-CONCIERGE-RUNTIME:
  parent: FUNC-CONCIERGE
  children: [STACK-CONCIERGE-NODE, STACK-CONCIERGE-BOARD]   # was: [STACK-CONCIERGE-NODE]
  status: draft
```

---

## Task 15 — test fixture name update (was stale)

The new test block inside Task 15 Step 1 references `FUNC-CHANNEL-SLACK` in two places (children-list assertion and the per-id loop). Rename to `FUNC-OPERATOR-CHANNEL`. Updated test:

```typescript
describe('concierge spec tree', () => {
  it('L0-CONCIERGE-VISION exists with five L1 children', () => {
    const raw = readFileSync(resolve(ROOT, '.specify/traceability.yml'), 'utf-8');
    expect(raw).toContain('L0-CONCIERGE-VISION:');
    expect(raw).toMatch(/L0-CONCIERGE-VISION:[\s\S]*?children:\s*\[FUNC-CONCIERGE.*FUNC-OBSERVER\]/);
  });

  it('all new concierge specs have entries', () => {
    const raw = readFileSync(resolve(ROOT, '.specify/traceability.yml'), 'utf-8');
    for (const id of [
      'FUNC-CONCIERGE', 'FUNC-CONCIERGE-MEMORY', 'FUNC-CONCIERGE-BOARD',
      'FUNC-OPERATOR-CHANNEL', 'FUNC-OBSERVER',
      'ARCH-CONCIERGE-RUNTIME', 'ARCH-EVENT-BUS', 'ARCH-TOOL-REGISTRY',
      'ARCH-CONFIRMATION-LIFECYCLE',
      'STACK-CONCIERGE-NODE', 'STACK-CONCIERGE-BOARD',
    ]) {
      expect(raw, `expected ${id} in traceability`).toContain(`${id}:`);
    }
  });
});
```

And in Task 15's traceability.yml additions, the L0 children list:

```yaml
L0-CONCIERGE-VISION:
  children: [FUNC-CONCIERGE, FUNC-CONCIERGE-MEMORY, FUNC-CONCIERGE-BOARD, FUNC-OPERATOR-CHANNEL, FUNC-OBSERVER]
  status: draft
```

---

## Task 24 / Definition of Done — reconcile with sequenced Task 23

The amended Task 23 opens only the FUNC-CONCIERGE issue first. Task 24 (PR description) and the Definition-of-Done section still say "5 follow-up issues opened". Reconcile.

Replacement Task 24 PR body excerpt:

```markdown
After this PR merges, opens **one** GitHub issue (`FUNC-CONCIERGE`) with `feature-pipeline,ready-to-implement,l1-approved,l2-approved,l3-approved` labels so the daemon picks up Phase 1 base implementation. Once that lands on `dev`, the remaining four concierge L1 issues (`FUNC-CONCIERGE-MEMORY`, `FUNC-OPERATOR-CHANNEL`, `FUNC-OBSERVER`, `FUNC-CONCIERGE-BOARD`) are opened in a follow-up.
```

Replacement Definition of Done:

```markdown
## Definition of done

- All 24 tasks committed.
- All tests green.
- PR open against `dev` with green CI.
- ONE follow-up issue (`FUNC-CONCIERGE`) opened with the right labels.
- Daemon log shows pickup of the FUNC-CONCIERGE issue (or a diagnosed reason if not).
- Remaining four concierge L1 issues are queued in a Phase-1 follow-up note (see plan §Phase 1) but NOT yet opened.
```

---

## Daemon coexistence — note update (was stale after Task 15 v2)

The "Daemon coexistence" section near the top of v1 plan says: *"No production code under `packages/` is modified."*

After Task 15 v2, Phase 0 creates `packages/concierge/` placeholder directory + package.json + README.md. Replace the daemon-coexistence paragraph with:

```markdown
## Daemon coexistence

The auto-claude daemon is running on the Mac mini. Phase 0 edits specs, prompts, traceability, tests, and creates a placeholder `packages/concierge/` skeleton (empty package.json + README + .gitkeep). **No existing production code under `packages/daemon/` or `packages/dashboard/` is modified.** The placeholder package adds no runtime behaviour — the daemon does not pick it up because it has no work-detection rules for it. After Phase 0 commits land on `dev`, the daemon picks up the new traceability tree and the FUNC-CONCIERGE issue (per Task 23 amendment) on its next poll cycle.
```

---

## Deferred to Phase 0.5: L2/L3 layer-purity polish

Codex iter 2 also flagged that v1 L2 specs name framework/library/protocol/code-level concepts (Node, SQLite, Hono, Slack, Cloudflare, launchd, HTTP, SSE) and v1 L3 specs are too complete (full directory trees, endpoint tables, event formats). Per `ARCH-SDD-LAYER-CONTRACT`:
- **L2 may use system names ("Backend", "Slack adapter") but not framework / library / protocol / code names.**
- **L3 should be patterns + key decisions + 3-5 line examples, not full contracts.**

**Decision: defer this purity polish to a Phase 0.5 PR after Phase 0 lands and the daemon picks up FUNC-CONCIERGE.**

Rationale:
1. Daemon's spec-implementation worker actually benefits from the over-detailed L2/L3 (more concrete guidance → less hallucination during implementation). Layer purity is a documentation rule the daemon does not enforce.
2. Phase 0 timing: deeper L2/L3 rewrites would extend Phase 0 by ~1 day; the marginal benefit doesn't justify delaying the daemon hand-off.
3. Once daemon successfully implements FUNC-CONCIERGE (Phase 1), authors can review the L2/L3 against the produced code and refine — that is when the layer-purity edits will be most informed.

**Phase 0.5 task list (to schedule after Phase 0 + daemon-FUNC-CONCIERGE merge, BEFORE the four follow-up issues are opened):**
1. Audit ARCH-CONCIERGE-RUNTIME for framework / library / protocol / file-path / config-shape leaks; rewrite using only system names.
2. Audit ARCH-EVENT-BUS, ARCH-TOOL-REGISTRY, ARCH-CONFIRMATION-LIFECYCLE for the same.
3. Trim STACK-CONCIERGE-NODE + STACK-CONCIERGE-BOARD to: pattern + key decisions + small examples + gotchas. Move full directory trees, endpoint tables, event-format tables to inline code comments under `packages/concierge/` once authored.
4. Reconcile traceability so each L2 has a single L1 parent (no `ARCH-CONCIERGE-RUNTIME` multi-parented across FUNC-CONCIERGE / FUNC-CONCIERGE-MEMORY / FUNC-CONCIERGE-BOARD; introduce `ARCH-CONCIERGE-MEMORY` and `ARCH-CONCIERGE-BOARD-RUNTIME` if needed for clean parentage).

---

## Iteration audit trail

| Iter | Codex verdict | Critical fixes applied | Files |
|---|---|---|---|
| 1 (this commit's parent) | L1 violations + 5 structural | 5 L1 rewrites + Task 14/15/23 fixes + rename | `2026-05-01-concierge-phase-0-amendments.md` |
| 2 (this file) | 3 L1 nits + Task 14/15 incomplete + DoD conflict + L2/L3 deferred | 3 L1 single-line fixes + Task 14/15 traceability completion + DoD reconciliation + Phase 0.5 schedule | `2026-05-01-concierge-phase-0-amendments-v2.md` |
| 3 (anticipated, post-execution) | TBD | Phase 0.5 layer-purity polish | TBD |

Daemon self-implementation status after this iter: **YES** for FUNC-CONCIERGE specifically (the only issue opened in the amended Task 23). Board issue blocked-by-design until Phase 1 first issue completes.
