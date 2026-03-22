# Autonomous Spec-Driven Development Pipeline

**Date:** 2026-03-22
**Status:** Draft
**Supersedes:** None (extends 2026-03-21-autonomous-self-improvement-design.md)
**Goal:** A self-accelerating pipeline where features flow from L1 specs through autonomous L2/L3 generation and implementation, with the Operator acting as PO/executive architect and the system as the dev team.

## Problem

The existing autonomous system (reviewer + developer) is reactive — it finds and fixes bugs. It cannot build forward. New features require manual spec writing, manual implementation planning, and manual implementation. The 10 L1 functional specs are draft status with gaps between what's specified and what's implemented. There is no autonomous path from "here's what the system should do" to "here's working, tested code."

## Solution

A spec-driven pipeline implemented as Claude Code skills, orchestrated by shell scripts with algorithmic pre-filtering. GitHub Issues with labels drive state transitions. The pipeline builds features by progressing through L1→L2→L3→implementation, with human gates at L1/L2 and full autonomy at L3+.

The pipeline uses itself to evolve from skills/scripts into auto-claude's native Node.js control plane (Phase 2/3).

## Role Model

The Operator (as defined in FUNC-AC-PIPELINE) acts as **Product Owner and Executive Architect**. The system is the **development team**. Every interaction must be high-signal — the system respects the Operator's time as the scarcest resource.

**Mapping to governing specs:** The Operator in this design combines the `Operator` role (configures, monitors, approves) and the `Spec Author` role (submits work requests with spec references) from FUNC-AC-PIPELINE. In Phase 1, these are the same person — the human user.

| Layer | Owner | System's Role |
|-------|-------|---------------|
| L1 (WHY) | Operator writes and owns | Can suggest changes only when implementation reveals fundamental impossibility. Requires `BLOCKING_REASON` with proof. Extremely rare. |
| L2 (HOW, structurally) | Operator reviews and approves | Proposes via self-brainstorming. Can suggest changes with concrete `EVIDENCE` (code/test output). Infrequent. |
| L3 (HOW, concretely) | System owns | Full autonomy. Writes, reviews, implements. |
| Code | System owns | Full autonomy with quality gates. |

### Spec Change Suggestion Bar

**L1 suggestion:** The agent must prove that the current L1 makes implementation *impossible* (not just harder). The issue body must contain a `BLOCKING_REASON` section with concrete evidence. Think: "this requirement contradicts physics." Expected frequency: ~1-2 per quarter on a mature project.

**L2 suggestion:** The agent must show concrete code or test output proving the current architecture doesn't work. The issue body must contain an `EVIDENCE` section. Think: "we need to restructure this module because X."

**Noise filter:** Suggestions that are cosmetic, "could be better," or preference-based are discarded before creating an issue. Only structural problems surface. The skill explicitly checks: "Would this prevent shipping? If no, discard."

### Phase 1 Exception: Interactive L2 Review

FUNC-AC-PIPELINE states "no interactive prompts during execution." Phase 1 relaxes this for L2 review only: after the agent posts an L2 design summary and PR, it **exits cleanly** and waits for the Operator to approve via label change. The next poll cycle picks up the approved issue. This is asynchronous — the agent never blocks waiting for input within a session. This exception is scoped to Phase 1 and will be formalized as a pipeline phase gate in Phase 2.

## Pipeline State Machine

Every feature starts as a GitHub Issue and progresses through label-driven stages.

### Transition Table

| Current State | Actor | Preconditions | Action | Labels Removed | Labels Added | Branch Action |
|---|---|---|---|---|---|---|
| (new issue) | Operator | L1 spec exists | Create issue | — | `feature-pipeline`, `l1-approved` | — |
| `l1-approved` | `spec-brainstorm-l2` skill | No `l2-in-progress` or `blocked` | Start L2 generation | `l1-approved` | `l2-in-progress` | Create `spec/l2/<N>-<name>` |
| `l2-in-progress` | `spec-brainstorm-l2` skill | L2 spec written, PR opened | Submit for review | `l2-in-progress` | `l2-review` | Push to `spec/l2/` branch, open PR |
| `l2-review` | Operator | Reviews PR/summary | Approve or request changes | `l2-review` | `l2-approved` (or back to `l2-in-progress` with comment) | Merge PR to `dev` |
| `l2-approved` | `spec-generate-l3` skill | No `l3-in-progress` or `blocked` | Start L3 generation | `l2-approved` | `l3-in-progress` | Create `spec/l3/<N>-<name>` |
| `l3-in-progress` | `spec-generate-l3` skill | L3 spec written | Submit for auto-review | `l3-in-progress` | `l3-review` | Push to `spec/l3/` branch, open PR |
| `l3-review` | `spec-generate-l3` skill | Compliance check passes | Mark ready | `l3-review` | `l3-approved`, `ready-to-implement` | Merge PR to `dev` |
| `l3-review` | `spec-generate-l3` skill | Compliance check fails 3x | Block | `l3-review` | `blocked` | — |
| `ready-to-implement` | `spec-implement` skill | No `implementing` or `blocked` | Start implementation | `ready-to-implement` | `implementing` | Create `feat/<N>-<name>` |
| `implementing` | `spec-implement` skill | Tests + review pass | Submit for final review | `implementing` | `in-review` | Push to `feat/` branch |
| `in-review` | `spec-implement` skill | Code review passes | Complete | `in-review` | — | Merge to `dev`, push, close issue |
| `in-review` | `spec-implement` skill | Code review fails 3x | Block | `in-review` | `blocked` | — |
| `blocked` (any state) | Operator | Resolves blocker | Resume | `blocked` | (restore previous state label) | — |

### Entry Points

1. **Operator-initiated:** Operator brainstorms L1 interactively with Claude, then creates a GitHub Issue with `feature-pipeline` + `l1-approved` labels, linking to the L1 spec file in `.specify/functional/`.
2. **Agent-suggested (L1):** Agent creates an issue with `spec-change-suggested` + `l1-suggestion`. Operator reviews and either relabels to `feature-pipeline` + `l1-approved`, or closes. Requires `BLOCKING_REASON` in body.
3. **Agent-suggested (L2):** Agent creates an issue with `spec-change-suggested` + `l2-suggestion`. Operator reviews and either relabels to `feature-pipeline` + `l2-approved` (if the L2 change is acceptable), or closes. Requires `EVIDENCE` in body.

### Issue Structure

- **Title:** Feature or spec area name
- **Body:** L1 spec reference, acceptance criteria, links to PRs as they're created
- **Labels:** Drive state (see Labels section)
- **Comments:** Feedback channel — agent reads and responds to comments on issues and PRs

### Labels

| Label | Purpose |
|-------|---------|
| `feature-pipeline` | Marks issue as spec-driven pipeline work (vs `review-finding` for maintenance) |
| `l1-approved` | L1 spec reviewed and approved by Operator |
| `l2-in-progress` | Agent is generating L2 spec |
| `l2-review` | L2 spec ready for Operator review (PR open) |
| `l2-approved` | Operator approved L2 spec |
| `l3-in-progress` | Agent is generating L3 spec |
| `l3-review` | L3 spec under automated review |
| `l3-approved` | L3 spec passed compliance review |
| `ready-to-implement` | Spec chain complete, implementation can begin |
| `implementing` | Implementation in progress |
| `in-review` | Implementation complete, code review in progress |
| `spec-change-suggested` | Agent suggests a spec change (requires evidence) |
| `l1-suggestion` | Suggested change is to L1 (requires BLOCKING_REASON) |
| `l2-suggestion` | Suggested change is to L2 (requires EVIDENCE) |
| `self-modification-suggestion` | Change to the pipeline's own specs (extra scrutiny) |
| `blocked` | Needs human input |
| `phase-2` | Earmarked for Phase 2 (not yet active) |
| `phase-3` | Earmarked for Phase 3 (not yet active) |

### Branch Convention

- L2 spec work: `spec/l2/<issue-number>-<short-name>` — merges to `dev` via PR on Operator approval
- L3 spec work: `spec/l3/<issue-number>-<short-name>` — merges to `dev` via PR on auto-review pass
- Implementation: `feat/<issue-number>-<short-name>` — merges to `dev` on code review pass
- All branch from `dev`

## Cost-Efficient Orchestration

### Algorithmic Pre-Filter

Shell scripts use `gh` CLI directly to check for eligible work **before** spawning a Claude session. No Claude invocation for empty queues.

The script checks all pipeline stages in priority order and only invokes Claude with a specific issue number and phase.

**Priority order:** Finish what's started before starting new work.
1. `ready-to-implement` issues without `implementing` or `blocked` (implementation)
2. `l2-approved` issues without `l3-in-progress` or `blocked` (L3 generation)
3. `l1-approved` issues without `l2-in-progress` or `blocked` (L2 brainstorming)

Note: `l3-review` is handled within the `spec-generate-l3` skill session (compliance check is part of L3 generation, not a separate orchestrator stage). The `in-review` state is handled within the `spec-implement` skill session (code review is part of implementation).

## Pipeline Skills

### 1. `spec-brainstorm-l2` (Self-Brainstorming Agent)

**Trigger:** Issue has `feature-pipeline` + `l1-approved` labels.

**Workflow:**
1. Add `l2-in-progress` label, remove `l1-approved`
2. Read the L1 spec referenced in the issue body
3. Read L0 vision and existing L2 specs for context and patterns
4. Self-brainstorm: ask architectural questions and answer them grounded in L1 constraints. Explore 2-3 approaches, pick the best with reasoning.
5. Validate generated spec using `l2-spec-guardian` skill (local skill at `plugins/auto-claude-dev/skills/spec-guardian/`)
6. Write L2 spec file(s) to `.specify/architecture/` on branch `spec/l2/<issue-number>-<name>`
7. Update `traceability.yml` with new spec linkages
8. Open PR linked to the issue
9. Update issue with a **design summary** (3-5 bullet points of key decisions + reasoning — respects Operator time)
10. Relabel: remove `l2-in-progress`, add `l2-review`
11. Exit cleanly — Operator reviews asynchronously

**On re-invocation (feedback received):** If the issue has `l2-review` and new comments exist since last run, read comments, update the L2 spec on the same branch, push, and update the PR.

**Evolution path:** Start as a single self-brainstorming agent. Later upgrade to adversarial two-agent conversation (one proposes, one challenges using L1 as ground truth).

### 2. `spec-generate-l3` (Fully Autonomous)

**Trigger:** Issue has `feature-pipeline` + `l2-approved` labels.

**Workflow:**
1. Add `l3-in-progress` label, remove `l2-approved`
2. Read approved L1 + L2 specs from the spec chain
3. Generate L3 spec(s) in `.specify/stack/` on branch `spec/l3/<issue-number>-<name>`
4. Update `traceability.yml` with `code_paths` and `test_paths`
5. Validate generated spec using `l3-spec-guardian` skill (local skill at `plugins/auto-claude-dev/skills/spec-guardian/`)
6. Run compliance check: does L3 contradict L2 or L1? Fix or create `l2-suggestion` issue with evidence.
7. Relabel: remove `l3-in-progress`, add `l3-review`
8. Run `spec-review-compliance` check against L1/L2/existing code
9. If compliance passes: merge PR to `dev`, relabel to `l3-approved` + `ready-to-implement`
10. If issues found: fix and re-review (max 3 iterations, then add `blocked`)

**Note on `spec-document-reviewer`:** This is a subagent prompt template defined in the brainstorming skill (`skills/brainstorming/spec-document-reviewer-prompt.md`), not a standalone skill. The `spec-generate-l3` skill dispatches it as a general-purpose Agent with the reviewer prompt.

### 3. `spec-review-compliance` (Quality Gate)

**Runs as:** Part of `spec-generate-l3` workflow (steps 8-10) and can be invoked independently for periodic audits.

**Checks:**
- L3 specs against actual code on `dev` — gaps where code doesn't match spec
- L3 against L2 and L1 for contradictions
- `traceability.yml` completeness — code files without spec coverage

**Outputs when run independently:**
- Code gaps: creates **new** implementation issues with `feature-pipeline` + `ready-to-implement` labels (separate from the triggering issue)
- Spec contradictions: creates suggestion issues at the appropriate layer with `spec-change-suggested`
- Traceability gaps: logs warnings, creates issues if significant

**Outputs when run as part of `spec-generate-l3`:**
- Returns pass/fail to the calling skill (does not create separate issues — the calling skill handles iteration or blocking)

### 4. `spec-implement` (Implementation from Approved L3)

**Trigger:** Issue has `feature-pipeline` + `ready-to-implement` labels.

**Workflow:**
1. Add `implementing` label, remove `ready-to-implement`
2. Read L3 spec, understand the full spec chain (L3→L2→L1)
3. Create implementation plan (as issue comment)
4. Scope guard: >20 steps or >10 files → add `blocked` label, remove `implementing`, request Operator decomposition
5. Branch `feat/<issue-number>-<name>` from `dev`
6. TDD: write tests first based on L3's `test_paths`
7. Implement until tests pass + typecheck passes
8. Run `pnpm -r run test` — zero regressions
9. Relabel: remove `implementing`, add `in-review`
10. Dispatch `requesting-code-review` superpower (this is a built-in superpower available in all Claude Code sessions, not a local skill)
11. If review fails, relabel back to `implementing`, iterate (max 3 attempts, then add `blocked`)
12. Merge `feat/` branch to `dev`, push to remote
13. Self-verify: check the fix works on merged `dev`
14. Remove `in-review` label, close issue with comment noting commit SHA

**Quality bar:** Same as existing developer skill — tests, typecheck, regression test, code review, clean merge, push to remote, self-verify.

**Note on `requesting-code-review`:** This is a Claude Code superpower (built-in capability), not a local skill file. It dispatches an independent reviewer subagent within the same Claude session.

## Coexistence with Maintenance Loop

The existing reviewer/developer loop continues handling `review-finding` issues. The new pipeline handles `feature-pipeline` issues. Different label namespaces prevent collision.

| Track | Labels | Script | Purpose |
|-------|--------|--------|---------|
| Maintenance | `review-finding` | `reviewer.sh` + `developer.sh` | Find and fix bugs, security issues, spec deviations |
| Feature pipeline | `feature-pipeline` | `pipeline.sh` | Build forward from L1 specs through implementation |

**Shared conventions:**
- Same branch model (`dev` as integration branch)
- Same quality bar (tests + typecheck + code review)
- Same GitHub Issues coordination
- Same cost guardrails (`--max-budget-usd`)

## Self-Accelerating Evolution

The pipeline uses itself to evolve. Phase 1 is scoped tightly to validate the workflow. Phases 2 and 3 are documented separately as future L1 issues.

### Phase 1: Bootstrap (Built Manually) — THIS SPEC

**Scope:** 4 skills + `pipeline.sh` orchestrator. Validates the L1→L2→L3→implement workflow end-to-end.

**What Phase 1 delivers:**
- The 4 pipeline skills (`spec-brainstorm-l2`, `spec-generate-l3`, `spec-review-compliance`, `spec-implement`)
- The `pipeline.sh` orchestrator with algorithmic pre-filtering
- Label creation on the GitHub repo
- Validation on at least one L1 spec area

**What Phase 1 does NOT deliver:**
- Complexity classification, crash resumption, single-instance enforcement (these are in FUNC-AC-PIPELINE but are Phase 2 concerns — the native control plane already handles them)
- Holdout/warmup, deploy/test phases (these are in FUNC-AC-QUALITY but require the native validation service)
- Dashboard integration (Phase 2+)
- Multi-repo support (stretch goal)

**"Done" for Phase 1:**
- L1→L2→L3→implementation flow works end-to-end for at least one spec area
- L2 self-brainstorming produces specs that pass Operator review within 2 iterations
- L3 generation is fully autonomous with no human intervention needed
- Implementation from L3 produces working, tested code
- Pipeline status visible via `gh issue list` and GitHub labels

**First target:** Core pipeline specs (FUNC-AC-PIPELINE, FUNC-AC-IMPLEMENTATION, FUNC-AC-QUALITY). Note: Phase 1 validates the *workflow* on these specs — it doesn't implement the full scope of these specs (complexity classification, holdout, etc.). That implementation happens through the pipeline itself once the workflow is proven.

### Phase 2 and Phase 3 (Future — Separate Specs)

Phase 2 (native pipeline migration) and Phase 3 (convergence) are documented as L1 issues with `phase-2`/`phase-3` labels, created upfront but not activated until Phase 1 proves stable. Each will get its own design spec through this pipeline.

**Phase 2 examples:**
- "The spec-driven pipeline should run as a native auto-claude pipeline variant (`spec-driven`) instead of shell scripts"
- "The pipeline orchestrator should use the Node.js control plane FSM instead of `pipeline.sh`"

**Phase 3 examples:**
- "The reviewer/developer maintenance loop should run as pipeline variants"
- "Dashboard should show all pipeline tracks with live status"

When Phase 1 proves stable, the Operator relabels Phase 2 issues to `l1-approved` and the pipeline implements its own migration.

**Translation map (Phase 1 → Phase 2):**

| Phase 1 (skills/scripts) | Phase 2 (native auto-claude) |
|---|---|
| `pipeline.sh` polling loop | Control plane FSM + polling |
| Label-based state in shell | `github-labels.ts` state management |
| `spec-brainstorm-l2` skill prompt | Session prompt template for `l2-design` phase |
| `spec-implement` skill prompt | Implementation coordinator with task graphs |
| `--max-budget-usd` flag | Cost tracking + circuit breakers |
| Exponential backoff in bash | Rate limiting module |

### Guard Rails for Self-Evolution

- The pipeline can never modify its own L1/L2 specs (L0 principle: "never modifies its own implementation" generalized to "never modifies its own requirements")
- It CAN modify its own L3 specs and code
- Suggested L1/L2 changes during self-evolution get `self-modification-suggestion` label — requires explicit Operator approval
- Tests must pass before AND after — the pipeline cannot break itself
- Never reads `.specify/scenarios/` — holdout test isolation must be preserved (AGENTS.md rule 4)
- Never modifies `.specify/methodology/` — protected governance specs (AGENTS.md rule 3)

## Local-First Mac Setup

The pipeline runs locally on the Mac, not on Hetzner. This simplifies the stack:

- **No Docker** — local git worktrees for workspace isolation
- **CLI adapter** — `claude` command invoked directly
- **Local daemon** — Node.js process (Phase 2) or shell script (Phase 1)
- **Dashboard** — Next.js dev server on localhost connecting to local daemon API (Phase 2+)
- **State** — JSON files on disk + GitHub Issues

The Hetzner deployment continues as-is. Local and remote don't need to coordinate — they work on different repos or different branches.

## Existing Skill Integration

| Existing Skill/Tool | Type | Location | Role in Pipeline |
|---|---|---|---|
| `l1-spec-guardian` | Local skill | `plugins/auto-claude-dev/skills/spec-guardian/` | Validates L1 spec quality during brainstorming |
| `l2-spec-guardian` | Local skill | `plugins/auto-claude-dev/skills/spec-guardian/` | Used by `spec-brainstorm-l2` to validate generated L2 |
| `l3-spec-guardian` | Local skill | `plugins/auto-claude-dev/skills/spec-guardian/` | Used by `spec-generate-l3` to validate generated L3 |
| `verified-codebase-review` | Claude Code skill | `~/.claude/skills/verified-codebase-review/` | Maintenance track only (not used in feature pipeline) |
| `fix-review-issues` | Claude Code skill | `~/.claude/skills/fix-review-issues/` | Maintenance track only (not used in feature pipeline) |
| `progress-summary` | Claude Code skill | `~/.claude/skills/progress-summary/` | Reports on pipeline + maintenance activity |
| `requesting-code-review` | Built-in superpower | (part of Claude Code) | Quality gate in `spec-implement` step 10 |
| `spec-document-reviewer` | Subagent prompt | `skills/brainstorming/spec-document-reviewer-prompt.md` | Dispatched as Agent in `spec-generate-l3` |

**New skills to build (Phase 1):**
- `spec-brainstorm-l2` — new Claude Code skill
- `spec-generate-l3` — new Claude Code skill
- `spec-review-compliance` — new Claude Code skill (can also run standalone)
- `spec-implement` — new Claude Code skill (replaces `fix-review-issues` for feature pipeline track)

## Orchestrator Script

**`scripts/pipeline.sh`:**

```bash
#!/bin/bash
cd ~/code/auto-claude
REPO="DANIELSOCRAHANDLEZZ/auto-claude"
FAIL_COUNT=0
MAX_BACKOFF=3600

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [pipeline] $*"; }

rotate_log() {
  local logfile="$1"
  if [ -f "$logfile" ] && [ $(stat -f%z "$logfile" 2>/dev/null || echo 0) -gt 10485760 ]; then
    mv "$logfile" "$logfile.$(date +%Y%m%d%H%M%S)"
    gzip "$logfile".* 2>/dev/null &
  fi
}

# Check for issues at a given stage, excluding specific labels
# Usage: check_stage "target-label" "exclude1" "exclude2" ...
check_stage() {
  local target="$1"; shift
  local result
  result=$(gh issue list --repo "$REPO" \
    --label "feature-pipeline,$target" \
    --state open --json number,title,labels 2>/dev/null)

  # Filter out issues that have any of the excluded labels
  for exclude in "$@"; do
    result=$(echo "$result" | jq \
      "[.[] | select(.labels | map(.name) | contains([\"$exclude\"]) | not)]" 2>/dev/null)
  done
  echo "$result"
}

find_work() {
  local eligible

  # Priority 1: Implementation work (finish what's started)
  eligible=$(check_stage "ready-to-implement" "implementing" "blocked")
  if [ "$(echo "$eligible" | jq 'length' 2>/dev/null)" -gt 0 ]; then
    ISSUE_NUM=$(echo "$eligible" | jq -r '.[0].number')
    SKILL="spec-implement"
    return 0
  fi

  # Priority 2: L3 generation from approved L2
  eligible=$(check_stage "l2-approved" "l3-in-progress" "blocked")
  if [ "$(echo "$eligible" | jq 'length' 2>/dev/null)" -gt 0 ]; then
    ISSUE_NUM=$(echo "$eligible" | jq -r '.[0].number')
    SKILL="spec-generate-l3"
    return 0
  fi

  # Priority 3: L2 brainstorming from approved L1
  eligible=$(check_stage "l1-approved" "l2-in-progress" "blocked")
  if [ "$(echo "$eligible" | jq 'length' 2>/dev/null)" -gt 0 ]; then
    ISSUE_NUM=$(echo "$eligible" | jq -r '.[0].number')
    SKILL="spec-brainstorm-l2"
    return 0
  fi

  return 1
}

while true; do
  rotate_log ~/logs/claude-pipeline.log

  if ! git checkout dev -q 2>/dev/null || ! git pull --ff-only -q 2>/dev/null; then
    log "WARN: git pull failed, attempting merge pull"
    GIT_MERGE_AUTOEDIT=no git pull --no-rebase --no-edit -q 2>/dev/null || {
      log "ERROR: git pull failed"
      sleep 300
      continue
    }
  fi

  if find_work; then
    log "Found work: issue #$ISSUE_NUM → skill $SKILL"
    claude --dangerously-skip-permissions -p --max-budget-usd 10 \
      "Use the $SKILL skill to work on issue #$ISSUE_NUM in repo $REPO. Read the issue body for context and spec references."
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
      FAIL_COUNT=0
      date '+%Y-%m-%d %H:%M:%S' > ~/logs/claude-pipeline.heartbeat
      log "Pipeline cycle complete for issue #$ISSUE_NUM"
      # Push whatever branch the skill worked on (dev, spec/*, feat/*)
      git push origin HEAD -q 2>/dev/null
      sleep 10
    else
      FAIL_COUNT=$((FAIL_COUNT + 1))
      BACKOFF=$(( 60 * (2 ** (FAIL_COUNT - 1)) ))
      [ $BACKOFF -gt $MAX_BACKOFF ] && BACKOFF=$MAX_BACKOFF
      log "ERROR: claude failed on issue #$ISSUE_NUM (attempt $FAIL_COUNT), backing off ${BACKOFF}s"
      sleep $BACKOFF
    fi
  else
    log "No eligible pipeline work found, sleeping 10 minutes"
    sleep 600
  fi
done
```

## Cost Guardrails

- **Per-invocation cap:** `--max-budget-usd 10` per pipeline session
- **Algorithmic pre-filter:** Zero Claude cost when no eligible work exists
- **Exponential backoff:** On failures, 60s→120s→240s→...→1h max
- **Kill switch:** `Ctrl+C` stops immediately (or `launchctl unload` if running as launchd agent)
- **Estimated daily cost:** With active backlog: $50-150/day. With empty backlog: ~$0/day (only `gh` API calls).

## Success Criteria (Phase 1 Only)

- L1→L2→L3→implementation flow works end-to-end for at least one functional spec area
- L2 self-brainstorming produces architecturally sound specs that pass Operator review on first or second iteration
- L3 generation is fully autonomous with no human intervention needed
- Implementation from L3 produces working, tested code
- Pipeline status visible via `gh issue list` and GitHub labels
- Zero regressions — `dev` stays green throughout
