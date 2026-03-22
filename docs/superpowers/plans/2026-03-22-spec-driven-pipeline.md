# Spec-Driven Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build 4 Claude Code skills and 1 orchestrator script that autonomously progress features from approved L1 specs through L2/L3 generation and implementation, coordinated via GitHub Issue labels.

**Architecture:** GitHub Issues with labels drive a state machine. Shell script polls for eligible work algorithmically (no Claude cost for empty queues), then invokes Claude with the appropriate skill and issue number. Each skill handles one pipeline phase: L2 brainstorming, L3 generation, compliance review, or implementation.

**Tech Stack:** Claude Code skills (Markdown), Bash shell scripts, `gh` CLI for GitHub API, `jq` for JSON filtering, `git` for branch management.

**Spec:** `docs/superpowers/specs/2026-03-22-spec-driven-pipeline-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `~/.claude/skills/spec-brainstorm-l2/SKILL.md` | Create | Self-brainstorms L2 architecture specs from approved L1 |
| `~/.claude/skills/spec-generate-l3/SKILL.md` | Create | Generates L3 stack specs from approved L2, runs compliance |
| `~/.claude/skills/spec-review-compliance/SKILL.md` | Create | Quality gate: checks L3 against L1/L2 and code |
| `~/.claude/skills/spec-implement/SKILL.md` | Create | Implements code from approved L3 specs with TDD |
| `scripts/pipeline.sh` | Create | Orchestrator: polls GitHub, invokes skills |
| `scripts/health.sh` | Modify | Add pipeline heartbeat + stale mid-phase detection |

---

### Task 1: Create GitHub Labels

**Files:**
- None (GitHub API only)

- [ ] **Step 1: Create all pipeline labels via `gh` CLI**

```bash
# Run from auto-claude repo directory
gh label create "feature-pipeline" --color "1D76DB" --description "Spec-driven pipeline work" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "l1-approved" --color "0E8A16" --description "L1 spec approved by Operator" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "l2-in-progress" --color "FBCA04" --description "Agent generating L2 spec" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "l2-review" --color "D93F0B" --description "L2 spec ready for Operator review" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "l2-approved" --color "0E8A16" --description "Operator approved L2 spec" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "l3-in-progress" --color "FBCA04" --description "Agent generating L3 spec" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "l3-review" --color "D93F0B" --description "L3 spec under automated review" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "l3-approved" --color "0E8A16" --description "L3 spec passed compliance" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "ready-to-implement" --color "0E8A16" --description "Spec chain complete, ready for implementation" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "implementing" --color "FBCA04" --description "Implementation in progress" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "spec-change-suggested" --color "E4E669" --description "Agent suggests spec change" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "l1-suggestion" --color "E4E669" --description "Suggested change to L1 spec" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "l2-suggestion" --color "E4E669" --description "Suggested change to L2 spec" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "self-modification-suggestion" --color "B60205" --description "Pipeline suggests change to own specs" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "phase-2" --color "C5DEF5" --description "Earmarked for Phase 2" --repo DANIELSOCRAHANDLEZZ/auto-claude
gh label create "phase-3" --color "C5DEF5" --description "Earmarked for Phase 3" --repo DANIELSOCRAHANDLEZZ/auto-claude
```

- [ ] **Step 2: Verify labels exist**

Run: `gh label list --repo DANIELSOCRAHANDLEZZ/auto-claude --json name | jq '[.[] | .name] | sort'`
Expected: All 16 new labels present alongside existing labels.

- [ ] **Step 3: Commit (nothing to commit — labels are on GitHub)**

---

### Task 2: Create `spec-brainstorm-l2` Skill

**Files:**
- Create: `~/.claude/skills/spec-brainstorm-l2/SKILL.md`

- [ ] **Step 1: Create the skill file**

```markdown
---
name: spec-brainstorm-l2
description: >-
  Use when autonomously generating L2 architecture specs from approved L1 functional specs.
  Triggered by GitHub Issues with feature-pipeline + l1-approved labels (new work) or
  feature-pipeline + l2-in-progress labels (feedback re-run). Self-brainstorms architectural
  decisions grounded in L1 constraints, writes spec to .specify/architecture/, opens PR.
---

# Spec Brainstorm L2

## Output Format
Prefix ALL terminal output with `[HH:MM]` timestamp.

## Overview
Self-brainstorm an L2 architecture spec from an approved L1 functional spec. Read the L1 spec,
explore 2-3 architectural approaches grounded in L1 constraints, pick the best with reasoning,
write the L2 spec, and submit for Operator review via PR.

## Workflow

### Determine Mode
1. Read the issue body to get the L1 spec reference
2. Check current labels:
   - If `l1-approved` is present → **New Work** mode
   - If `l2-in-progress` is present → **Feedback Re-run** mode

### New Work Mode

1. **Claim the issue**
   ```bash
   gh issue edit <N> --remove-label "l1-approved" --add-label "l2-in-progress" --repo DANIELSOCRAHANDLEZZ/auto-claude
   ```

2. **Read the spec chain**
   - Read the L1 spec referenced in the issue body (in `.specify/functional/`)
   - Read `.specify/L0-vision.md` for system boundaries
   - Read existing L2 specs in `.specify/architecture/` for patterns and conventions
   - Read `AGENTS.md` rules (especially: L2 must be language-agnostic, rule 8)

3. **Self-brainstorm**
   - Ask yourself 5-7 key architectural questions (e.g., "What are the system boundaries?", "How does data flow?", "What needs to be isolated?")
   - Answer each grounded in L1 constraints
   - Propose 2-3 approaches with trade-offs
   - Pick the best and document reasoning

4. **Write the L2 spec**
   - Create branch: `git checkout -b spec/l2/<issue-number>-<short-name> dev`
   - Write spec file to `.specify/architecture/<spec-id>.md`
   - Follow L2 format: YAML frontmatter (id, type: architecture, domain, status: draft, version: 1, layer: 2, parent), then sections
   - Use the `l2-spec-guardian` skill to validate format and content
   - Update `.specify/traceability.yml` with new spec linkages

5. **Open PR and update issue**
   ```bash
   git add .specify/
   git commit -m "spec(l2): add <spec-id> architecture spec for issue #<N>"
   git push origin spec/l2/<issue-number>-<short-name>
   gh pr create --title "L2: <spec title>" --body "Closes #<N> (L2 phase)\n\n## Design Summary\n<3-5 bullets>" --repo DANIELSOCRAHANDLEZZ/auto-claude
   ```

6. **Submit for review**
   ```bash
   gh issue comment <N> --body "## L2 Design Summary\n\n<3-5 bullet points of key decisions + reasoning>\n\nPR: <PR-URL>" --repo DANIELSOCRAHANDLEZZ/auto-claude
   gh issue edit <N> --remove-label "l2-in-progress" --add-label "l2-review" --repo DANIELSOCRAHANDLEZZ/auto-claude
   ```

7. **Exit cleanly** — Operator reviews asynchronously

### Feedback Re-run Mode

1. **Read feedback**
   - Read issue comments since last update
   - Read PR review comments if any
   - Identify what needs to change

2. **Update the L2 spec**
   - Check out the existing branch: `git checkout spec/l2/<issue-number>-<short-name>`
   - Make changes based on feedback
   - Re-validate with `l2-spec-guardian`

3. **Push and resubmit**
   ```bash
   git add .specify/
   git commit -m "spec(l2): address feedback on <spec-id> for issue #<N>"
   git push origin spec/l2/<issue-number>-<short-name>
   gh issue comment <N> --body "Updated L2 spec based on feedback:\n\n<summary of changes>" --repo DANIELSOCRAHANDLEZZ/auto-claude
   gh issue edit <N> --remove-label "l2-in-progress" --add-label "l2-review" --repo DANIELSOCRAHANDLEZZ/auto-claude
   ```

4. **Exit cleanly**

## Spec Change Suggestions

If during brainstorming you discover that the L1 spec makes implementation **impossible** (not just harder):
1. Create a suggestion issue:
   ```bash
   gh issue create --title "L1 suggestion: <description>" \
     --label "spec-change-suggested,l1-suggestion" \
     --body "## BLOCKING_REASON\n\n<proof that L1 makes implementation impossible>\n\nRelated to #<parent-issue>" \
     --repo DANIELSOCRAHANDLEZZ/auto-claude
   ```
2. Do NOT modify the L1 spec yourself.
3. Continue brainstorming with the current L1 as-is, noting the limitation.

## Guard Rails
- Never modify L1 specs
- Never read `.specify/scenarios/` (holdout isolation)
- Never modify `.specify/methodology/`
- L2 specs must be language-agnostic (no framework names — see AGENTS.md rule 8 blocklist)
- Always validate with `l2-spec-guardian` before submitting
```

- [ ] **Step 2: Verify skill file exists and is valid YAML frontmatter**

Run: `head -5 ~/.claude/skills/spec-brainstorm-l2/SKILL.md`
Expected: YAML frontmatter with `name: spec-brainstorm-l2`

- [ ] **Step 3: Commit**

```bash
git add ~/.claude/skills/spec-brainstorm-l2/SKILL.md  # Note: this is outside repo, no git commit needed
```

Note: Skills at `~/.claude/skills/` are outside the repo — no git commit. They take effect immediately.

---

### Task 3: Create `spec-generate-l3` Skill

**Files:**
- Create: `~/.claude/skills/spec-generate-l3/SKILL.md`

- [ ] **Step 1: Create the skill file**

```markdown
---
name: spec-generate-l3
description: >-
  Use when autonomously generating L3 stack-specific specs from approved L2 architecture specs.
  Triggered by GitHub Issues with feature-pipeline + l2-approved labels. Generates L3 spec,
  validates with l3-spec-guardian, runs compliance check, opens PR, and auto-promotes to
  ready-to-implement if compliance passes.
---

# Spec Generate L3

## Output Format
Prefix ALL terminal output with `[HH:MM]` timestamp.

## Overview
Generate L3 stack-specific specs from an approved L2 architecture spec. Read the full spec chain
(L1→L2), generate L3 with concrete patterns and library choices, validate compliance against
upstream specs, and auto-promote to implementation if everything checks out.

## Workflow

1. **Claim the issue**
   ```bash
   gh issue edit <N> --remove-label "l2-approved" --add-label "l3-in-progress" --repo DANIELSOCRAHANDLEZZ/auto-claude
   ```

2. **Read the spec chain**
   - Read issue body for spec references
   - Read the L1 spec (`.specify/functional/`)
   - Read the L2 spec (`.specify/architecture/`)
   - Read `.specify/L0-vision.md` for boundaries
   - Read existing L3 specs in `.specify/stack/` for patterns and conventions
   - Read `AGENTS.md` rules (L3 contains patterns not implementations, rule 9)

3. **Generate L3 spec**
   - Create branch: `git checkout -b spec/l3/<issue-number>-<short-name> dev`
   - Write spec file(s) to `.specify/stack/<spec-id>.md`
   - Follow L3 format: YAML frontmatter (id, type: stack, domain, status: draft, version: 1, layer: 3, parent), named patterns, 3-5 line code snippets, library choices with rationale
   - Include `code_paths` and `test_paths` in the spec
   - Update `.specify/traceability.yml` with new spec, code_paths, and test_paths

4. **Validate with guardian**
   - Use the `l3-spec-guardian` skill to validate format and content
   - Fix any issues flagged

5. **Compliance check (inline mode)**
   - Check: Does L3 contradict L2? Does L3 contradict L1?
   - Check: Is `traceability.yml` correctly updated with linkages?
   - Do NOT check code gaps (code doesn't exist yet for new features)
   - If L2 must change: create `l2-suggestion` issue with evidence, block the feature issue:
     ```bash
     gh issue create --title "L2 suggestion: <description>" \
       --label "spec-change-suggested,l2-suggestion" \
       --body "## EVIDENCE\n\n<concrete code/test output proving L2 doesn't work>\n\nBlocks #<N>" \
       --repo DANIELSOCRAHANDLEZZ/auto-claude
     gh issue edit <N> --add-label "blocked" --remove-label "l3-in-progress" --repo DANIELSOCRAHANDLEZZ/auto-claude
     gh issue comment <N> --body "Blocked: L2 change needed. See #<suggestion-number>" --repo DANIELSOCRAHANDLEZZ/auto-claude
     ```
     Then exit.

6. **Submit for auto-review**
   ```bash
   git add .specify/
   git commit -m "spec(l3): add <spec-id> stack spec for issue #<N>"
   git push origin spec/l3/<issue-number>-<short-name>
   gh pr create --title "L3: <spec title>" --body "Part of #<N>\n\nL3 stack spec generated from L2." --repo DANIELSOCRAHANDLEZZ/auto-claude
   gh issue edit <N> --remove-label "l3-in-progress" --add-label "l3-review" --repo DANIELSOCRAHANDLEZZ/auto-claude
   ```

7. **Run compliance review**
   - Dispatch a subagent (general-purpose Agent) with the spec-document-reviewer prompt to review L3 quality
   - If review passes:
     ```bash
     gh pr merge <PR-NUMBER> --squash --repo DANIELSOCRAHANDLEZZ/auto-claude
     git checkout dev && git pull --ff-only
     gh issue edit <N> --remove-label "l3-review" --add-label "l3-approved" --add-label "ready-to-implement" --repo DANIELSOCRAHANDLEZZ/auto-claude
     gh issue comment <N> --body "L3 spec approved and merged. Ready for implementation." --repo DANIELSOCRAHANDLEZZ/auto-claude
     ```
   - If review fails: fix issues, re-push, re-review (max 3 iterations)
   - If 3 failures:
     ```bash
     gh issue edit <N> --add-label "blocked" --remove-label "l3-review" --repo DANIELSOCRAHANDLEZZ/auto-claude
     gh issue comment <N> --body "BLOCKED: L3 compliance review failed 3 times. Needs Operator review." --repo DANIELSOCRAHANDLEZZ/auto-claude
     ```

## Guard Rails
- Never modify L1 or L2 specs (only suggest changes via issues)
- Never read `.specify/scenarios/`
- Never modify `.specify/methodology/`
- L3 specs contain patterns and examples (3-5 lines), never complete implementations (AGENTS.md rule 9)
- Always validate with `l3-spec-guardian` before submitting
```

- [ ] **Step 2: Verify skill file exists**

Run: `head -5 ~/.claude/skills/spec-generate-l3/SKILL.md`
Expected: YAML frontmatter with `name: spec-generate-l3`

- [ ] **Step 3: Note — no git commit needed (skill is outside repo)**

---

### Task 4: Create `spec-review-compliance` Skill

**Files:**
- Create: `~/.claude/skills/spec-review-compliance/SKILL.md`

- [ ] **Step 1: Create the skill file**

```markdown
---
name: spec-review-compliance
description: >-
  Use when reviewing L3 specs against L1/L2 for compliance, or auditing code against specs.
  Two modes: inline (within spec-generate-l3, checks upstream consistency only) and standalone
  (periodic audit, also checks code gaps). Creates GitHub Issues for gaps found.
---

# Spec Review Compliance

## Output Format
Prefix ALL terminal output with `[HH:MM]` timestamp.

## Overview
Quality gate that checks L3 specs against L1/L2 for contradictions and verifies traceability.
In standalone mode, also checks code against specs to find implementation gaps.

## Modes

### Inline Mode (called from spec-generate-l3)
When invoked with a specific L3 spec file path:
1. Read the L3 spec
2. Read its parent L2 spec (from traceability.yml `parent` field)
3. Read the L1 spec (from L2's `parent` field)
4. Check for contradictions:
   - Does L3 specify behavior that L2 forbids or doesn't cover?
   - Does L3 specify behavior that contradicts L1 requirements?
   - Are L3 patterns compatible with L2's system boundaries?
5. Check traceability:
   - Does `.specify/traceability.yml` have the new L3 spec entry?
   - Are `code_paths` and `test_paths` specified?
   - Does the `parent` field point to the correct L2 spec?
6. Output: `PASS` or `FAIL` with list of issues

**Do NOT check code gaps in inline mode** — code doesn't exist yet for new features.

### Standalone Mode (periodic audit)
When invoked without a specific file (audit the whole repo):
1. Read all L3 specs from `.specify/stack/`
2. For each L3 spec, run all inline checks PLUS:
   - Read files listed in `code_paths` from traceability.yml
   - Compare code behavior against L3 spec patterns
   - Flag gaps where code doesn't implement what L3 specifies
3. Output results:
   - Code gaps → create GitHub Issues:
     ```bash
     gh issue create --title "Implementation gap: <description>" \
       --label "feature-pipeline,ready-to-implement" \
       --body "**L3 Spec:** <spec-id>\n**Gap:** <what's missing>\n**Code path:** <file>" \
       --repo DANIELSOCRAHANDLEZZ/auto-claude
     ```
   - Spec contradictions → create suggestion issues:
     ```bash
     gh issue create --title "L2 suggestion: <description>" \
       --label "spec-change-suggested,l2-suggestion" \
       --body "## EVIDENCE\n\n<contradiction details>" \
       --repo DANIELSOCRAHANDLEZZ/auto-claude
     ```
   - Traceability gaps → log warning, create issue if significant

## Guard Rails
- Never modify any spec files — only read and report
- Never read `.specify/scenarios/`
- Check for duplicate issues before creating new ones:
  ```bash
  gh issue list --label "feature-pipeline" --state open --json title --repo DANIELSOCRAHANDLEZZ/auto-claude | jq '.[].title'
  ```
```

- [ ] **Step 2: Verify skill file exists**

Run: `head -5 ~/.claude/skills/spec-review-compliance/SKILL.md`
Expected: YAML frontmatter with `name: spec-review-compliance`

- [ ] **Step 3: Note — no git commit needed (skill is outside repo)**

---

### Task 5: Create `spec-implement` Skill

**Files:**
- Create: `~/.claude/skills/spec-implement/SKILL.md`

- [ ] **Step 1: Create the skill file**

```markdown
---
name: spec-implement
description: >-
  Use when implementing code from approved L3 specs. Triggered by GitHub Issues with
  feature-pipeline + ready-to-implement labels. TDD workflow: write tests from L3 test_paths,
  implement until passing, code review via requesting-code-review superpower, merge to dev.
---

# Spec Implement

## Output Format
Prefix ALL terminal output with `[HH:MM]` timestamp. Log each major step.

## Overview
Implement code from an approved L3 spec. Read the full spec chain, plan the implementation,
write tests first (TDD), implement, get code review, merge to dev, and close the issue.

## Workflow

1. **Claim the issue**
   ```bash
   gh issue edit <N> --remove-label "ready-to-implement" --add-label "implementing" --repo DANIELSOCRAHANDLEZZ/auto-claude
   ```

2. **Read the spec chain**
   - Read issue body for spec references
   - Read the L3 spec (`.specify/stack/`) — this is your implementation guide
   - Read the L2 spec (`.specify/architecture/`) — system boundaries
   - Read the L1 spec (`.specify/functional/`) — business requirements
   - Read `traceability.yml` for `code_paths` and `test_paths`

3. **Plan the implementation**
   - Post plan as issue comment:
     ```bash
     gh issue comment <N> --body "## Implementation Plan\n\n<numbered steps>\n\n**Files:** <list>\n**Tests:** <list>" --repo DANIELSOCRAHANDLEZZ/auto-claude
     ```
   - **Scope guard:** If plan has >20 steps or touches >10 files:
     ```bash
     gh issue edit <N> --add-label "blocked" --remove-label "implementing" --repo DANIELSOCRAHANDLEZZ/auto-claude
     gh issue comment <N> --body "BLOCKED: Scope too large (>20 steps or >10 files). Needs Operator decomposition." --repo DANIELSOCRAHANDLEZZ/auto-claude
     ```
     Then exit.

4. **Create branch**
   ```bash
   git checkout dev && git pull --ff-only
   git checkout -b feat/<issue-number>-<short-name>
   ```

5. **TDD: Write tests first**
   - Read `test_paths` from traceability.yml for this spec
   - Write failing tests based on L3 spec's expected behavior
   - Run tests to confirm they fail:
     ```bash
     pnpm -r run test
     ```

6. **Implement**
   - Write minimal code to make tests pass
   - Follow L3 spec patterns exactly
   - Run tests after each change:
     ```bash
     pnpm -r run test
     ```
   - Run typecheck:
     ```bash
     pnpm -r run typecheck  # or tsc --noEmit
     ```

7. **Full test suite**
   ```bash
   pnpm -r run test
   ```
   ALL tests must pass — zero regressions.

8. **Code review**
   - Use the `requesting-code-review` superpower to dispatch an independent reviewer
   - If review fails: fix issues, re-test, re-review
   - Max 3 attempts. If all fail:
     ```bash
     gh issue edit <N> --add-label "blocked" --remove-label "implementing" --repo DANIELSOCRAHANDLEZZ/auto-claude
     gh issue comment <N> --body "BLOCKED: Code review failed 3 times.\n\n<review feedback>" --repo DANIELSOCRAHANDLEZZ/auto-claude
     ```
     Then exit.

9. **Merge and push**
   ```bash
   git checkout dev && git pull --ff-only
   git checkout feat/<issue-number>-<short-name>
   git rebase dev
   # If rebase fails: retry once, then block
   pnpm -r run test  # Re-run after rebase
   git checkout dev
   git merge --ff-only feat/<issue-number>-<short-name>
   git push origin dev
   git branch -d feat/<issue-number>-<short-name>
   ```

10. **Self-verify**
    - On merged `dev`, verify the implementation works:
      ```bash
      pnpm -r run test
      ```

11. **Close the issue**
    ```bash
    COMMIT_SHA=$(git rev-parse --short HEAD)
    gh issue edit <N> --remove-label "implementing" --repo DANIELSOCRAHANDLEZZ/auto-claude
    gh issue close <N> --comment "Implemented in commit $COMMIT_SHA on dev. Tests pass. Code review passed." --repo DANIELSOCRAHANDLEZZ/auto-claude
    ```

## Spec Change Suggestions

If during implementation you discover the L3 spec is wrong but L2 is fine:
- Fix the L3 spec yourself (you have L3 ownership)
- Update traceability.yml if needed
- Continue implementation

If L2 must change:
- Create a suggestion issue with `EVIDENCE`
- Block the feature issue
- Exit

If L1 must change (extremely rare):
- Create a suggestion issue with `BLOCKING_REASON`
- Block the feature issue
- Exit

## Guard Rails
- Never modify L1 or L2 specs
- Never read `.specify/scenarios/`
- Never modify `.specify/methodology/`
- Always run full test suite before merging
- Always push to remote after merging to dev
- Always self-verify on merged dev
```

- [ ] **Step 2: Verify skill file exists**

Run: `head -5 ~/.claude/skills/spec-implement/SKILL.md`
Expected: YAML frontmatter with `name: spec-implement`

- [ ] **Step 3: Note — no git commit needed (skill is outside repo)**

---

### Task 6: Create `pipeline.sh` Orchestrator Script

**Files:**
- Create: `scripts/pipeline.sh`

- [ ] **Step 1: Create the orchestrator script**

Copy the script exactly from the spec: `docs/superpowers/specs/2026-03-22-spec-driven-pipeline-design.md` lines 355-463.

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
  local target="$1"; shift
  local result
  result=$(gh issue list --repo "$REPO" \
    --label "feature-pipeline,$target" \
    --state open --json number,title,labels 2>/dev/null)

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

  # Priority 3: L2 feedback re-run (Operator sent back from l2-review)
  eligible=$(check_stage "l2-in-progress" "blocked")
  if [ "$(echo "$eligible" | jq 'length' 2>/dev/null)" -gt 0 ]; then
    ISSUE_NUM=$(echo "$eligible" | jq -r '.[0].number')
    SKILL="spec-brainstorm-l2"
    return 0
  fi

  # Priority 4: L2 brainstorming from approved L1 (new work)
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

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/pipeline.sh`

- [ ] **Step 3: Verify script syntax**

Run: `bash -n scripts/pipeline.sh && echo "Syntax OK"`
Expected: `Syntax OK`

- [ ] **Step 4: Commit**

```bash
git add scripts/pipeline.sh
git commit -m "feat: add pipeline.sh orchestrator for spec-driven pipeline"
```

---

### Task 7: Update `health.sh` for Pipeline Monitoring

**Files:**
- Modify: `scripts/health.sh`

- [ ] **Step 1: Read current health.sh**

Run: `cat scripts/health.sh`

- [ ] **Step 2: Add pipeline heartbeat check and stale mid-phase detection**

Add after the existing reviewer/developer checks:

```bash
# Pipeline heartbeat
for role in reviewer developer pipeline; do
  # ... existing heartbeat check logic
done

# Stale mid-phase detection for pipeline
echo ""
echo "=== Pipeline Mid-Phase Issues ==="
for label in l3-in-progress l3-review implementing; do
  STALE=$(gh issue list --repo DANIELSOCRAHANDLEZZ/auto-claude \
    --label "feature-pipeline,$label" \
    --state open --json number,title,updatedAt \
    --jq "[.[] | select((.updatedAt | fromdateiso8601) < (now - 3600))]" 2>/dev/null)
  COUNT=$(echo "$STALE" | jq 'length' 2>/dev/null)
  if [ "$COUNT" -gt 0 ]; then
    echo "WARNING: $COUNT stale issue(s) with label '$label' (>1hr without update):"
    echo "$STALE" | jq -r '.[] | "  #\(.number): \(.title)"'
  fi
done
```

- [ ] **Step 3: Verify script syntax**

Run: `bash -n scripts/health.sh && echo "Syntax OK"`
Expected: `Syntax OK`

- [ ] **Step 4: Commit**

```bash
git add scripts/health.sh
git commit -m "feat: add pipeline heartbeat and stale mid-phase detection to health.sh"
```

---

### Task 8: Smoke Test — Create a Test Issue and Verify Orchestrator Picks It Up

**Files:**
- None (manual verification)

- [ ] **Step 1: Create a test issue**

```bash
gh issue create \
  --title "TEST: Pipeline smoke test — FUNC-AC-PIPELINE L2 generation" \
  --label "feature-pipeline,l1-approved" \
  --body "## L1 Spec Reference\n\n\`.specify/functional/pipeline-orchestration.md\` (FUNC-AC-PIPELINE)\n\n## Acceptance Criteria\n\n- L2 architecture spec generated for pipeline orchestration\n- Spec passes l2-spec-guardian validation\n- PR opened for Operator review\n\n**This is a smoke test issue. Close after verifying the pipeline picks it up.**" \
  --repo DANIELSOCRAHANDLEZZ/auto-claude
```

- [ ] **Step 2: Verify the orchestrator finds it**

Run the `find_work` function manually:

```bash
cd ~/code/auto-claude
source <(sed -n '/^REPO=/p; /^check_stage/,/^}/p; /^find_work/,/^}/p' scripts/pipeline.sh)
REPO="DANIELSOCRAHANDLEZZ/auto-claude"
find_work && echo "Found: issue #$ISSUE_NUM → skill $SKILL" || echo "No work found"
```

Expected: `Found: issue #<N> → skill spec-brainstorm-l2`

- [ ] **Step 3: Run one pipeline cycle (optional — only if ready for autonomous run)**

```bash
cd ~/code/auto-claude
bash scripts/pipeline.sh  # Ctrl+C after first cycle completes
```

Watch for:
- `[pipeline] Found work: issue #<N> → skill spec-brainstorm-l2`
- Claude session starts and reads the L1 spec
- L2 spec gets written to `.specify/architecture/`
- PR gets created
- Issue gets relabeled from `l1-approved` to `l2-review`

- [ ] **Step 4: Verify issue state changed**

```bash
gh issue view <N> --json labels --jq '.labels[].name' --repo DANIELSOCRAHANDLEZZ/auto-claude
```

Expected: `feature-pipeline`, `l2-review` (not `l1-approved`)

- [ ] **Step 5: Close test issue if this was just a smoke test**

```bash
gh issue close <N> --comment "Smoke test complete. Pipeline picked up issue and executed spec-brainstorm-l2." --repo DANIELSOCRAHANDLEZZ/auto-claude
```

---

### Task 9: Create Phase 2/3 Placeholder Issues

**Files:**
- None (GitHub API only)

- [ ] **Step 1: Create Phase 2 issues**

```bash
gh issue create \
  --title "Phase 2: Migrate pipeline.sh to native auto-claude control plane FSM" \
  --label "feature-pipeline,phase-2" \
  --body "The spec-driven pipeline should run as a native auto-claude pipeline variant (\`spec-driven\`) instead of shell scripts.\n\nSee: \`docs/superpowers/specs/2026-03-22-spec-driven-pipeline-design.md\` Phase 2 section.\n\n**Not active until Phase 1 proves stable.**" \
  --repo DANIELSOCRAHANDLEZZ/auto-claude

gh issue create \
  --title "Phase 2: Use CLI adapter from session runtime instead of direct claude invocation" \
  --label "feature-pipeline,phase-2" \
  --body "Sessions should use the CLI adapter from session runtime instead of direct \`claude\` invocation.\n\nSee: \`docs/superpowers/specs/2026-03-22-spec-driven-pipeline-design.md\` Translation map.\n\n**Not active until Phase 1 proves stable.**" \
  --repo DANIELSOCRAHANDLEZZ/auto-claude
```

- [ ] **Step 2: Create Phase 3 issues**

```bash
gh issue create \
  --title "Phase 3: Migrate reviewer/developer to native pipeline variants" \
  --label "feature-pipeline,phase-3" \
  --body "The reviewer/developer maintenance loop should run as pipeline variants (\`review\`, \`fix\`).\n\nSee: \`docs/superpowers/specs/2026-03-22-spec-driven-pipeline-design.md\` Phase 3 section.\n\n**Not active until Phase 2 proves stable.**" \
  --repo DANIELSOCRAHANDLEZZ/auto-claude

gh issue create \
  --title "Phase 3: Dashboard shows all pipeline tracks with live status" \
  --label "feature-pipeline,phase-3" \
  --body "Dashboard should show all pipeline tracks (feature, review, fix) with live status.\n\nSee: \`docs/superpowers/specs/2026-03-22-spec-driven-pipeline-design.md\` Phase 3 section.\n\n**Not active until Phase 2 proves stable.**" \
  --repo DANIELSOCRAHANDLEZZ/auto-claude
```

- [ ] **Step 3: Verify issues created**

```bash
gh issue list --label "feature-pipeline" --repo DANIELSOCRAHANDLEZZ/auto-claude --json number,title,labels
```

Expected: Test issue + 4 placeholder issues visible.

---

### Task 10: Final Verification and Documentation

**Files:**
- None

- [ ] **Step 1: Verify all skills are loadable**

```bash
for skill in spec-brainstorm-l2 spec-generate-l3 spec-review-compliance spec-implement; do
  if [ -f "$HOME/.claude/skills/$skill/SKILL.md" ]; then
    echo "✓ $skill"
  else
    echo "✗ $skill MISSING"
  fi
done
```

Expected: All 4 skills show ✓

- [ ] **Step 2: Verify pipeline.sh is executable**

Run: `test -x scripts/pipeline.sh && echo "OK" || echo "NOT EXECUTABLE"`
Expected: `OK`

- [ ] **Step 3: Verify all labels exist**

```bash
for label in feature-pipeline l1-approved l2-in-progress l2-review l2-approved l3-in-progress l3-review l3-approved ready-to-implement implementing spec-change-suggested l1-suggestion l2-suggestion self-modification-suggestion phase-2 phase-3; do
  gh label list --repo DANIELSOCRAHANDLEZZ/auto-claude --json name --jq ".[].name" | grep -q "^${label}$" && echo "✓ $label" || echo "✗ $label MISSING"
done
```

Expected: All 16 labels show ✓

- [ ] **Step 4: Commit plan document**

```bash
git add docs/superpowers/plans/2026-03-22-spec-driven-pipeline.md
git commit -m "docs: add spec-driven pipeline implementation plan"
```
