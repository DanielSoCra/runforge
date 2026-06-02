> **🗄 HISTORICAL (2026-06-02).** Completed/superseded record, kept for provenance — superseded by the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. The canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# Concierge Phase 0 — Amendments v3 (Codex iter 3 — final)

Apply v1 plan ⊕ v1 amendments ⊕ v2 amendments ⊕ this v3. After v3, the iteration converges; proceed to execution.

Codex iter 3 verdict: 3 L1 nits, 4 internal-consistency issues, 1 sequencing fix. None block daemon self-implementation.

---

## L1 nits — three single-line fixes

### FUNC-CONCIERGE

In **Problem Statement**, replace:
- **From:** `Each workstream has its own home — a knowledge vault, an issue tracker, a calendar, a mailbox, a delivery pipeline.`
- **To:** `Each workstream has its own context, commitments, communications, and delivery obligations.`

### FUNC-CONCIERGE-MEMORY

In **Out of Scope**, replace:
- **From:** `Operator-facing memory inspection beyond the standard durable-store browser.`
- **To:** `Operator-facing memory inspection beyond normal access to durable records.`

### FUNC-OBSERVER

In the status-snapshot scenario, replace:
- **From:** `Then a recent (≤ one polling interval old) status snapshot is returned`
- **To:** `Then a recent-enough status snapshot is returned according to the operator-approved freshness target.`

---

## Task 23 — move issue creation to AFTER PR merge

The daemon polls the configured branch. Until the Phase 0 PR is merged to `dev`, the daemon sees no concierge specs. Therefore the FUNC-CONCIERGE issue creation must happen post-merge, not pre-merge.

Replacement Task 23 structure:

```markdown
### Task 23: Push branch and verify Phase 0 PR can be merged

(Existing Step 1: push the branch — unchanged.)

- [ ] **Step 2: Wait for PR review and merge to `dev`.**
  Phase 0 changes specs/prompts/traceability/tests/placeholder-package only.
  Once green CI and any human review pass, merge to `dev`. The daemon picks up
  the new traceability tree on its next poll cycle (≤2 min).

- [ ] **Step 3: After merge to `dev`, open ONLY the FUNC-CONCIERGE issue.**

  ```bash
  gh issue create \
    --title "Implement FUNC-CONCIERGE (concierge core)" \
    --body "..." \
    --label "feature-pipeline,ready-to-implement,l1-approved,l2-approved,l3-approved" \
    --label "concierge,phase-1"
  ```

  (Body unchanged from v1 amendments Task 23 Step 2.)

- [ ] **Step 4: Verify daemon pickup**

  ```bash
  tail -f ~/Library/Logs/auto-claude/daemon.log | grep -E "(FUNC-CONCIERGE|concierge|spec-impl)"
  ```

  Expected within ≤2 poll cycles: daemon classifies the issue and starts a
  spec-implementation worker.

- [ ] **Step 5: If daemon does NOT pick it up, diagnose** (unchanged from v1).

  After daemon successfully merges its first concierge implementation PR to
  `dev`, plan the four follow-up issues (FUNC-CONCIERGE-MEMORY,
  FUNC-OPERATOR-CHANNEL, FUNC-OBSERVER, FUNC-CONCIERGE-BOARD) — each
  conditional on Phase 0.5 layer-purity polish landing first per v2 schedule.
```

---

## Task 24 / Definition of Done — post-merge sequencing

Replacement Definition of Done:

```markdown
## Definition of done

- All 24 tasks committed.
- All tests green.
- PR open and **merged** to `dev` with green CI.
- ONE follow-up issue (`FUNC-CONCIERGE`) opened post-merge with the right labels.
- Daemon log shows pickup of the FUNC-CONCIERGE issue (or a diagnosed reason if not).
- Phase 0.5 layer-purity polish (per v2 amendments) is the next planning step;
  the remaining four concierge L1 issues are NOT yet opened.
```

Replacement Task 24 PR body (unchanged from v2 amendments) is correct as written; the change here is only the DoD bullet wording.

---

## Internal consistency fixes

### Daemon-coexistence note

The v2 amendment said "no existing production code under `packages/daemon/` or `packages/dashboard/` is modified", which contradicts Task 1 (spec-loader change in `packages/daemon/`), Task 17 (integration.ts comment), Task 20 (dashboard scaffold notes). Replace daemon-coexistence text with:

```markdown
## Daemon coexistence

The auto-claude daemon is running on the Mac mini. Phase 0 makes:

- A small additive change to `packages/daemon/src/infra/spec-loader.ts`
  (multi-L0 root scan, ~50 LOC) and its tests. Backward-compatible — the
  existing AC subtree resolution is unchanged.
- One comment-only edit at `packages/daemon/src/control-plane/integration.ts:73`.
- One comment-only edit at `packages/dashboard/lib/scaffold-templates.ts`.
- A new placeholder `packages/concierge/` skeleton (package.json, README,
  .gitkeep). Adds no runtime behaviour; the daemon's work-detection rules
  do not target it.

Net daemon impact at runtime: identical until the daemon picks up the
FUNC-CONCIERGE issue (per Task 23 amendment), at which point spec-pipeline
runs against the new traceability subtree. **No daemon restart required**;
launchd-managed daemon picks up filesystem changes on next poll cycle.
```

### Task 15 commit command

Add the test file to the git-add line. Replacement:

```bash
git add .specify/traceability.yml \
        packages/daemon/src/infra/traceability-paths.test.ts \
        packages/concierge/

git commit -m "spec(traceability): add concierge subtree + placeholder package"
```

### "Empty package.json" wording

In the daemon-coexistence note above, the placeholder package.json is **non-empty** (it has name, scripts) but **functionally inert** (scripts are no-ops). Wording is now consistent with Task 15 v2: `placeholder packages/concierge/ skeleton`, not `empty`.

---

## Convergence statement

After v3, no further amendments planned. Iteration audit:

| Iter | Codex verdict | Critical fixes |
|---|---|---|
| 1 | L1 contract violations + 5 structural | 5 L1 rewrites + Task 14/15/23 + rename |
| 2 | 3 L1 nits + Task 14/15 incomplete + DoD conflict + L2/L3 deferred | 3 L1 fixes + Task 14/15 traceability completion + DoD reconciliation + Phase 0.5 schedule |
| 3 (this) | 3 L1 nits + 4 consistency + Task 23 post-merge sequencing | 3 L1 single-line + 4 consistency notes + Task 23 sequencing fix |

**Daemon self-implementation final verdict: YES** — for the FUNC-CONCIERGE issue per amended Task 23 (post-merge to `dev`).

**Plan is ready for subagent-driven execution.** The implementer applies v1 plan ⊕ v1 amendments ⊕ v2 amendments ⊕ v3 amendments in the obvious left-to-right precedence: later amendments override earlier ones for the items they touch.
