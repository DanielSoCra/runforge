# Autonomous Spec-Driven Development Pipeline

**Date:** 2026-03-22
**Status:** Draft
**Supersedes:** None (extends 2026-03-21-autonomous-self-improvement-design.md)
**Goal:** A self-accelerating pipeline where features flow from L1 specs through autonomous L2/L3 generation and implementation, with the user acting as PO/executive architect and the system as the dev team.

## Problem

The existing autonomous system (reviewer + developer) is reactive — it finds and fixes bugs. It cannot build forward. New features require manual spec writing, manual implementation planning, and manual implementation. The 10 L1 functional specs are draft status with gaps between what's specified and what's implemented. There is no autonomous path from "here's what the system should do" to "here's working, tested code."

## Solution

A spec-driven pipeline implemented as Claude Code skills, orchestrated by shell scripts with algorithmic pre-filtering. GitHub Issues with labels drive state transitions. The pipeline builds features by progressing through L1→L2→L3→implementation, with human gates at L1/L2 and full autonomy at L3+.

The pipeline uses itself to evolve from skills/scripts into auto-claude's native Node.js control plane (Phase 2/3).

## Role Model

The user is the **Product Owner and Executive Architect**. The system is the **development team**. Every interaction must be high-signal — the system respects the user's time as the scarcest resource.

| Layer | Owner | System's Role |
|-------|-------|---------------|
| L1 (WHY) | User writes and owns | Can suggest changes only when implementation reveals fundamental impossibility. Requires `BLOCKING_REASON` with proof. Extremely rare. |
| L2 (HOW, structurally) | User reviews and approves | Proposes via self-brainstorming. Can suggest changes with concrete `EVIDENCE` (code/test output). Infrequent. |
| L3 (HOW, concretely) | System owns | Full autonomy. Writes, reviews, implements. |
| Code | System owns | Full autonomy with quality gates. |

### Spec Change Suggestion Bar

**L1 suggestion:** The agent must prove that the current L1 makes implementation *impossible* (not just harder). The issue body must contain a `BLOCKING_REASON` section with concrete evidence. Think: "this requirement contradicts physics." Expected frequency: ~1-2 per quarter on a mature project.

**L2 suggestion:** The agent must show concrete code or test output proving the current architecture doesn't work. The issue body must contain an `EVIDENCE` section. Think: "we need to restructure this module because X."

**Noise filter:** Suggestions that are cosmetic, "could be better," or preference-based are discarded before creating an issue. Only structural problems surface. The skill explicitly checks: "Would this prevent shipping? If no, discard."

## Pipeline State Machine

Every feature starts as a GitHub Issue and progresses through label-driven stages:

```
[l1-approved] → [l2-in-progress] → [l2-review] → [l2-approved] →
[l3-in-progress] → [l3-review] → [l3-approved] →
[ready-to-implement] → [implementing] → [in-review] → [complete (issue closed)]
```

### Entry Points

1. **Human-initiated:** User brainstorms L1 interactively with Claude, then creates a GitHub Issue with `feature-pipeline` + `l1-approved` labels, linking to the L1 spec file in `.specify/functional/`.
2. **Agent-suggested:** During work, the agent discovers something that needs a new feature. It creates an issue with `spec-change-suggested` + the layer label (`l1-suggestion` or `l2-suggestion`). The user reviews and either relabels to `l1-approved` or closes.

### Issue Structure

- **Title:** Feature or spec area name
- **Body:** L1 spec reference, acceptance criteria, links to PRs as they're created
- **Labels:** Drive state (see Labels section)
- **Comments:** Feedback channel — agent reads and responds to comments on issues and PRs

### Labels

| Label | Purpose |
|-------|---------|
| `feature-pipeline` | Marks issue as spec-driven pipeline work (vs `review-finding` for maintenance) |
| `l1-approved` | L1 spec reviewed and approved by user |
| `l2-in-progress` | Agent is generating L2 spec |
| `l2-review` | L2 spec ready for user review (PR open) |
| `l2-approved` | User approved L2 spec |
| `l3-in-progress` | Agent is generating L3 spec |
| `l3-review` | L3 spec under automated review |
| `l3-approved` | L3 spec passed compliance review |
| `ready-to-implement` | Spec chain complete, implementation can begin |
| `implementing` | Implementation in progress |
| `in-review` | Implementation complete, code review in progress |
| `spec-change-suggested` | Agent suggests a spec change (requires evidence) |
| `l1-suggestion` | Suggested change is to L1 |
| `l2-suggestion` | Suggested change is to L2 |
| `self-modification-suggestion` | Change to the pipeline's own specs (extra scrutiny) |
| `blocked` | Needs human input |
| `phase-2` | Earmarked for Phase 2 (not yet active) |
| `phase-3` | Earmarked for Phase 3 (not yet active) |

### Branch Convention

- L2 spec work: `spec/l2/<issue-number>-<short-name>`
- L3 spec work: `spec/l3/<issue-number>-<short-name>`
- Implementation: `feat/<issue-number>-<short-name>`
- All branch from and merge to `dev`

## Cost-Efficient Orchestration

### Algorithmic Pre-Filter

Shell scripts use `gh` CLI directly to check for eligible work **before** spawning a Claude session. No Claude invocation for empty queues.

```bash
# Example: check for l2-approved issues ready for L3 generation
ELIGIBLE=$(gh issue list \
  --repo DANIELSOCRAHANDLEZZ/auto-claude \
  --label "feature-pipeline,l2-approved" \
  --json number,title,labels \
  --jq '[.[] | select(.labels | map(.name) |
    (contains(["l3-in-progress"]) or contains(["blocked"])) | not)]')

if [ "$(echo "$ELIGIBLE" | jq 'length')" -eq 0 ]; then
  log "No eligible work at this stage"
  # Fall through to check next stage
fi
```

The script checks all pipeline stages in priority order (implementation first, then L3, then L2) and only invokes Claude with a specific issue number and phase.

**Priority order:** Finish what's started before starting new work.
1. `ready-to-implement` issues (implementation)
2. `l3-approved` issues needing compliance review
3. `l2-approved` issues (L3 generation)
4. `l1-approved` issues (L2 brainstorming)

## Pipeline Skills

### 1. `spec-brainstorm-l2` (Self-Brainstorming Agent)

**Trigger:** Issue has `feature-pipeline` + `l1-approved` labels.

**Workflow:**
1. Read the L1 spec referenced in the issue body
2. Read L0 vision and existing L2 specs for context and patterns
3. Self-brainstorm: ask architectural questions and answer them grounded in L1 constraints. Explore 2-3 approaches, pick the best with reasoning.
4. Write L2 spec file(s) to `.specify/architecture/` on branch `spec/l2/<issue-number>-<name>`
5. Update `traceability.yml` with new spec linkages
6. Open PR linked to the issue
7. Update issue with a **design summary** (3-5 bullet points of key decisions + reasoning — respects PO time)
8. Relabel: remove `l1-approved`, add `l2-review`
9. If user comments on PR or issue with feedback, re-run against the feedback, update PR

**Evolution path:** Start as a single self-brainstorming agent. Later upgrade to adversarial two-agent conversation (one proposes, one challenges using L1 as ground truth).

### 2. `spec-generate-l3` (Fully Autonomous)

**Trigger:** Issue has `feature-pipeline` + `l2-approved` labels.

**Workflow:**
1. Read approved L1 + L2 specs from the spec chain
2. Generate L3 spec(s) in `.specify/stack/` on branch `spec/l3/<issue-number>-<name>`
3. Update `traceability.yml` with `code_paths` and `test_paths`
4. Run compliance check: does L3 contradict L2 or L1? Fix or create `l2-suggestion` issue with evidence.
5. Use `spec-document-reviewer` subagent to review L3 quality
6. Open PR, update issue
7. Relabel: remove `l2-approved`, add `l3-review`
8. Automated reviewer checks L3 against L1/L2/existing code
9. If review passes: relabel `l3-approved` + `ready-to-implement`
10. If issues found: fix and re-review (max 3 iterations, then `blocked`)

### 3. `spec-review-compliance` (Quality Gate)

**Runs as:** Part of `spec-generate-l3` and periodically as an independent check.

**Checks:**
- L3 specs against actual code on `dev` — gaps where code doesn't match spec
- L3 against L2 and L1 for contradictions
- `traceability.yml` completeness — code files without spec coverage

**Outputs:**
- Code gaps: creates implementation issues with `l3-approved` + `ready-to-implement`
- Spec contradictions: creates suggestion issues at the appropriate layer
- Traceability gaps: logs warnings, creates issues if significant

### 4. `spec-implement` (Implementation from Approved L3)

**Trigger:** Issue has `feature-pipeline` + `ready-to-implement` labels.

**Workflow:**
1. Read L3 spec, understand the full spec chain (L3→L2→L1)
2. Create implementation plan (as issue comment)
3. Scope guard: >20 steps or >10 files → add `blocked` label, request human decomposition
4. Branch `feat/<issue-number>-<name>` from `dev`
5. TDD: write tests first based on L3's `test_paths`
6. Implement until tests pass + typecheck passes
7. Run `pnpm -r run test` — zero regressions
8. Dispatch `requesting-code-review` superpower
9. If review fails, iterate (max 3 attempts, then `blocked`)
10. Rebase onto latest `dev`, merge, push
11. Self-verify: check the fix works on merged `dev`
12. Relabel and close issue

**Quality bar:** Same as existing developer skill — tests, typecheck, regression test, code review, clean merge, push to remote, self-verify.

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

The pipeline uses itself to evolve through three phases.

### Phase 1: Bootstrap (Built Manually)

- 4 skills + `pipeline.sh` orchestrator
- Algorithmic pre-filter via `gh` CLI
- Validates workflow on core pipeline specs (FUNC-AC-PIPELINE, FUNC-AC-IMPLEMENTATION, FUNC-AC-QUALITY)
- Runs on Mac alongside existing reviewer/developer

### Phase 2: Native Pipeline (Built by Phase 1)

L1 issues created upfront, labeled `phase-2`:
- "The spec-driven pipeline should run as a native auto-claude pipeline variant (`spec-driven`) instead of shell scripts"
- "The pipeline orchestrator should use the Node.js control plane FSM instead of `pipeline.sh`"
- "Sessions should use the CLI adapter from session runtime instead of direct `claude` invocation"

When Phase 1 proves stable, the user relabels these to `l1-approved` and the pipeline implements its own migration from bash to Node.js.

**Translation map:**

| Phase 1 (skills/scripts) | Phase 2 (native auto-claude) |
|---|---|
| `pipeline.sh` polling loop | Control plane FSM + polling |
| Label-based state in shell | `github-labels.ts` state management |
| `spec-brainstorm-l2` skill prompt | Session prompt template for `l2-design` phase |
| `spec-implement` skill prompt | Implementation coordinator with task graphs |
| `--max-budget-usd` flag | Cost tracking + circuit breakers |
| Git worktree in script | Workspace management module |
| Exponential backoff in bash | Rate limiting module |

### Phase 3: Convergence (Built by Phase 2)

L1 issues created upfront, labeled `phase-3`:
- "The reviewer/developer maintenance loop should run as pipeline variants (`review`, `fix`)"
- "Dashboard should show all pipeline tracks (feature, review, fix) with live status"
- "All orchestration should live in the Node.js runtime — shell scripts retired"

### Guard Rails for Self-Evolution

- The pipeline can never modify its own L1/L2 specs (L0 principle: "never modifies its own implementation" generalized to "never modifies its own requirements")
- It CAN modify its own L3 specs and code
- Suggested L1/L2 changes during self-evolution get `self-modification-suggestion` label — requires explicit human approval
- Tests must pass before AND after — the pipeline cannot break itself
- Never reads `.specify/scenarios/` — holdout test isolation must be preserved (AGENTS.md rule 2)
- Never modifies `.specify/methodology/` — protected governance specs (AGENTS.md rule 1)

## Local-First Mac Setup

The pipeline runs locally on the Mac, not on Hetzner. This simplifies the stack:

- **No Docker** — local git worktrees for workspace isolation
- **CLI adapter** — `claude` command invoked directly
- **Local daemon** — Node.js process (Phase 2) or shell script (Phase 1)
- **Dashboard** — Next.js dev server on localhost connecting to local daemon API (Phase 2+)
- **State** — JSON files on disk + GitHub Issues

The Hetzner deployment continues as-is. Local and remote don't need to coordinate — they work on different repos or different branches.

## Existing Skill Integration

| Existing Skill/Tool | Role in Pipeline |
|---|---|
| `verified-codebase-review` | Evolves into L3 compliance reviewer |
| `fix-review-issues` | Evolves into `spec-implement` |
| `progress-summary` | Reports on pipeline activity |
| `requesting-code-review` superpower | Quality gate in implementation phase |
| `spec-document-reviewer` | Reviews generated L2/L3 specs |
| `l1-spec-guardian` | Validates L1 spec quality during brainstorming |
| `l2-spec-guardian` | Used by `spec-brainstorm-l2` to validate generated L2 |
| `l3-spec-guardian` | Used by `spec-generate-l3` to validate generated L3 |

## First Target

The first run targets the core pipeline: **FUNC-AC-PIPELINE**, **FUNC-AC-IMPLEMENTATION**, and **FUNC-AC-QUALITY**.

1. User brainstorms L1 refinements interactively — make these three specs precise and complete
2. User creates issues with `feature-pipeline` + `l1-approved` linking to each spec
3. Pipeline self-brainstorms L2, opens PRs for review
4. On approval, L3 generated and auto-reviewed
5. Implementation proceeds autonomously with TDD

**"Done" for the core pipeline (Phase 1):**
- Every L1 requirement has a traced path through L2→L3→code→tests
- End-to-end tests prove the pipeline works
- Pipeline status visible via `gh issue list` and GitHub labels (dashboard integration is Phase 2+)
- Auto-claude can be pointed at a new repo and it works

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

check_stage() {
  local label="$1"
  local exclude_labels="$2"
  gh issue list --repo "$REPO" --label "feature-pipeline,$label" \
    --state open --json number,title,labels --jq \
    "[.[] | select(.labels | map(.name) | ($(echo "$exclude_labels" | sed 's/,/ or contains(["/g; s/^/(contains(["/; s/$/"])/; s/\]/\"&/g')) | not)]" 2>/dev/null
}

find_work() {
  local eligible

  # Priority 1: Implementation work (finish what's started)
  eligible=$(check_stage "ready-to-implement" "implementing,blocked")
  if [ "$(echo "$eligible" | jq 'length' 2>/dev/null)" -gt 0 ]; then
    ISSUE_NUM=$(echo "$eligible" | jq -r '.[0].number')
    SKILL="spec-implement"
    return 0
  fi

  # Priority 2: L3 generation
  eligible=$(check_stage "l2-approved" "l3-in-progress,blocked")
  if [ "$(echo "$eligible" | jq 'length' 2>/dev/null)" -gt 0 ]; then
    ISSUE_NUM=$(echo "$eligible" | jq -r '.[0].number')
    SKILL="spec-generate-l3"
    return 0
  fi

  # Priority 3: L2 brainstorming
  eligible=$(check_stage "l1-approved" "l2-in-progress,blocked")
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
      git push origin dev -q 2>/dev/null
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
- **Kill switch:** `launchctl unload` or `Ctrl+C` stops immediately
- **Estimated daily cost:** With active backlog: $50-150/day. With empty backlog: ~$0/day (only `gh` API calls).

## Success Criteria

- L1→L2→L3→implementation flow works end-to-end for at least one functional spec
- L2 self-brainstorming produces architecturally sound specs that pass user review on first or second iteration
- L3 generation is fully autonomous with no human intervention needed
- Implementation from L3 produces working, tested code
- The pipeline successfully implements its own Phase 2 migration (self-acceleration proven)
- Zero regressions — `dev` stays green throughout
