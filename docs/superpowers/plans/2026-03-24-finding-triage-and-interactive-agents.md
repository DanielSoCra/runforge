> **⛔ SUPERSEDED (2026-06-02).** This design doc's still-valid content has been folded into the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. Retained for history; the canonical specs in `.specify/` govern — do not act on it as a live instruction. See the Spec Reconciliation Ledger (`docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). <!-- RECONCILIATION-LEDGER-BANNER -->

# Finding Triage + Interactive Agent Architecture — Spec Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write L0 updates and L1 spec amendments that define (a) Tech Lead finding triage, (b) PO finding approval gate with Operator approval step, and (c) interactive agent sessions for all agents. Work-detection code changes are deferred to L2→L3 pipeline.

**Architecture:** This is a spec-writing plan, not code. Each task produces spec content that feeds the existing L1→L2→L3 pipeline. The design was brainstormed with the operator and captured in `~/.claude/plans/tidy-jingling-starlight.md`.

**Tech Stack:** Markdown specs in `.specify/` directory, following existing L0/L1 format conventions.

---

### Task 1: Update L0 Vision — Interactive Agent Sessions

**Files:**
- Modify: `.specify/L0-vision.md`

The L0 currently describes the operator as someone who "creates work requests" and "reviews results." It needs to also describe the operator as someone who can **talk to any agent** interactively — the PO for priority discussions, the Tech Lead for architecture questions, the reviewer for targeted audits.

- [ ] **Step 1: Add interactive sessions to "What the harness provides"**

After the existing "Product co-ownership" bullet, add a new bullet:

```markdown
- **Interactive sessions** — any agent that operates autonomously in the daemon is also available as an interactive collaborator. The Operator can open a conversation with the PO to discuss priorities, with the Tech Lead to explore technical decisions, or with any other agent. The agent brings its current state (proposals, findings, health signals) into the conversation and can execute decisions on the spot. Same agent identity, same tools, same shared state — just a different execution mode.
```

- [ ] **Step 2: Update "For" paragraph**

Change:
```markdown
**For:** An Operator who writes specifications and creates work requests.
```
To:
```markdown
**For:** An Operator who writes specifications, creates work requests, and collaborates with agents through interactive sessions when decisions require discussion.
```

- [ ] **Step 3: Bump version to 4**

Change `version: 3` to `version: 4` in frontmatter.

- [ ] **Step 4: Commit**

```bash
git add .specify/L0-vision.md
git commit -m "spec(L0): add interactive agent sessions to vision (v4)"
```

---

### Task 2: Update FUNC-AC-TECH-LEAD — Finding Triage Scenarios

**Files:**
- Modify: `.specify/functional/tech-lead.md`

The Tech Lead spec defines signal analysis (reading findings) and proposal generation (proposing fixes), but nothing in between. It needs a **Finding Triage** section where the Tech Lead evaluates individual findings and makes triage decisions: approve for fixing, reject as false positive, promote severity, or defer.

This fills the gap identified in FUNC-AC-QUALITY which says findings become work "when the Tech Lead proposes remediation" — but the Tech Lead has no triage scenarios.

- [ ] **Step 5: Add Finding Triage section after Signal Analysis**

Insert after the "Signal Analysis" section, before "Proposal Generation":

```markdown
### Finding Triage

**Scenario: Tech Lead triages new review findings**
- Given the proactive reviewer has created findings as GitHub issues with `review-finding` label
- When untriaged findings exist (no `tl-triaged` label)
- Then the Tech Lead evaluates each finding for validity, proportionality, and impact
- And produces a triage decision for each: approve, reject, promote, or defer

**Scenario: Tech Lead approves a finding for fixing**
- Given a finding is valid and the fix is proportional to the effort
- When the Tech Lead decides to approve
- Then it labels the issue `tl-approved` and `tl-triaged`
- And adds a comment explaining why the fix is justified
- And the finding enters the PO approval queue

**Scenario: Tech Lead rejects a finding as invalid**
- Given a finding is a false positive, already resolved, or not worth fixing
- When the Tech Lead decides to reject
- Then it closes the issue with a comment explaining the rejection reason
- And labels it `tl-triaged` before closing

**Scenario: Tech Lead promotes finding severity**
- Given a P3 finding has higher impact than its severity suggests (e.g., it affects a critical path, or multiple P3 findings in the same area compound into a real problem)
- When the Tech Lead decides to promote
- Then it changes the severity label (e.g., P3 → P2) with a comment explaining the promotion reason
- And approves the finding (applies `tl-approved` and `tl-triaged`)

**Scenario: Tech Lead defers a finding**
- Given a finding is valid but not appropriate to fix now (e.g., area is being refactored, or higher-priority work is in progress)
- When the Tech Lead decides to defer
- Then it labels the issue `deferred` and `tl-triaged` with a comment explaining when it should be revisited

**Scenario: Tech Lead triage respects daily cap**
- Given a configurable daily cap exists for triage approvals (default: 5)
- When the Tech Lead has approved the maximum number of findings in the current day
- Then it defers remaining findings to the next cycle
- And this prevents capacity runaway from a large batch of findings
```

- [ ] **Step 6: Update Success Criteria**

Add to the existing success criteria:

```markdown
- Review findings are triaged within one Tech Lead cycle of creation
- False positives are closed with explanation rather than accumulating silently
- P3 findings with compounding impact are promoted rather than permanently ignored
```

- [ ] **Step 6b: Add Tech Lead Interactive Session scenarios**

Add after the "Self-Improvement Connection" section:

```markdown
### Interactive Sessions

**Scenario: Operator opens interactive session with Tech Lead**
- Given the operator starts an interactive session with the Tech Lead
- When the session initializes
- Then the Tech Lead loads its current state: recent findings, triage decisions, active proposals, system health signals, and failure patterns
- And proactively surfaces technical concerns requiring operator input

**Scenario: Operator discusses architecture with Tech Lead**
- Given the operator has questions about implementation approach or technical debt
- When they discuss during an interactive session
- Then the Tech Lead provides analysis grounded in current codebase state, findings, and spec-code drift data
- And any resulting decisions are recorded as proposals or triage actions
```

- [ ] **Step 7: Add triage constraints**

Add to the existing constraints:

```markdown
- Finding triage daily cap: configurable, default 5 approvals per day
- Triage decisions are always recorded as GitHub issue comments (audit trail)
- Triage does not bypass the PO approval gate — approved findings still require PO sign-off before becoming work
```

- [ ] **Step 8: Bump version to 2**

Change `version: 1` to `version: 2` in frontmatter.

- [ ] **Step 9: Commit**

```bash
git add .specify/functional/tech-lead.md
git commit -m "spec(L1): add finding triage scenarios to FUNC-AC-TECH-LEAD (v2)"
```

---

### Task 3: Update FUNC-AC-PRODUCT-OWNER — Finding Approval Gate + Interactive Sessions

**Files:**
- Modify: `.specify/functional/product-owner.md`

The PO spec needs two additions:
1. **Finding Approval Gate** — PO evaluates TL-approved findings and decides whether to spend capacity
2. **Interactive Sessions** — operator can open a conversation with the PO for priority discussions

- [ ] **Step 10: Add Finding Approval Gate section after Proposal Lifecycle**

Insert after the "Proposal Lifecycle" section, before "Interaction Protocols":

```markdown
### Finding Approval Gate

**Scenario: PO evaluates Tech Lead approved finding**
- Given the Tech Lead has labeled a review finding `tl-approved`
- When the PO's cycle processes findings awaiting approval
- Then the PO evaluates whether fixing this finding is justified given current priorities and capacity
- And either recommends (adds `po-approved` label) or rejects (adds `po-rejected` label with comment)

**Scenario: PO recommends finding for Operator approval**
- Given a `tl-approved` finding aligns with current priorities
- When the PO approves it
- Then it adds `po-approved` label and surfaces the finding to the Operator (via briefing or interactive session)
- And the finding becomes eligible for work detection only after the Operator confirms (adds `ready` label or equivalent)
- And the daily recommendation count increments

**Scenario: Operator confirms PO-approved finding**
- Given a finding has both `tl-approved` and `po-approved` labels
- When the Operator reviews the finding (via briefing, dashboard, or interactive session)
- Then the Operator either confirms (finding becomes executable work) or rejects with reason
- And this preserves the L0 boundary: no autonomous work creation without Operator approval

**Scenario: PO rejects finding**
- Given a `tl-approved` finding conflicts with current priorities or capacity
- When the PO rejects it
- Then it removes `tl-approved`, adds `po-rejected` label with a comment explaining the reason
- And the finding remains open but is not eligible for work detection

**Scenario: Tech Lead re-triages a PO-rejected finding**
- Given a finding has been labeled `po-rejected`
- When the Tech Lead has gathered new evidence or circumstances have changed
- Then it may re-triage the finding with a comment referencing the prior rejection and new justification
- And the finding re-enters the PO approval queue

**Scenario: PO finding approval respects daily cap**
- Given a configurable daily cap exists for PO finding approvals (default: 5, independent of Tech Lead triage cap)
- When the PO has recommended the maximum number of findings in the current day
- Then remaining `tl-approved` findings are deferred to the next cycle

**Scenario: Operator overrides triage via auto-fix-approved**
- Given the operator manually labels a finding `auto-fix-approved`
- When work detection scans for bug-fix work
- Then the finding is eligible regardless of TL/PO approval status
- And this preserves the operator's ability to bypass the triage lifecycle entirely

**Scenario: PO adds finding to needs-discussion queue**
- Given a `tl-approved` finding is ambiguous — the PO cannot decide without operator input
- When the PO encounters such a finding
- Then it adds the finding to a needs-discussion queue with context about what input is needed
- And the finding is surfaced in the next interactive session or briefing
```

- [ ] **Step 11: Add Interactive Sessions section after Operator Idea Flow**

Insert after the "Operator Idea Flow" section:

```markdown
### Interactive Sessions

**Scenario: Operator opens interactive session with PO**
- Given the operator starts an interactive session with the PO
- When the session initializes
- Then the PO loads its current state: pending proposals, needs-discussion items, recent autonomous decisions, triage queue, and backlog summary
- And proactively surfaces items requiring operator input

**Scenario: PO surfaces needs-discussion items**
- Given the needs-discussion queue contains items
- When an interactive session starts
- Then the PO presents each item with context: what the Tech Lead found, why the PO is uncertain, and what input would help
- And the operator's decisions are recorded and executed immediately

**Scenario: Operator makes decisions during interactive session**
- Given the operator approves or rejects items during conversation
- When a decision is made
- Then the PO executes it on the spot (applies labels, closes issues, updates proposals)
- And writes the decision to shared persistent state that the daemon reads on its next cycle

**Scenario: PO reviews recent autonomous decisions with operator**
- Given the PO has made autonomous decisions since the last interactive session
- When the operator opens a session
- Then the PO summarizes recent decisions for the operator's awareness
- And the operator can override any decision they disagree with
```

Note: The generic "interactive session for any agent" scenario belongs in L0 (Task 1 already adds this to the vision). PO-specific interactive scenarios live here. Tech Lead interactive scenarios will be added to FUNC-AC-TECH-LEAD in a separate step.

- [ ] **Step 12: Update Success Criteria**

Add to existing success criteria:

```markdown
- TL-approved findings are evaluated by PO within one cycle
- Ambiguous findings are queued for operator discussion rather than decided autonomously
- Interactive sessions surface all pending items without operator having to ask
- Operator decisions during interactive sessions are reflected in daemon behavior within one cycle
```

- [ ] **Step 13: Add constraints**

Add to existing constraints:

```markdown
- Finding approval daily cap: configurable, default 5 (independent of Tech Lead triage cap)
- PO never approves findings autonomously when uncertain — uses needs-discussion queue
- Interactive sessions share persistent state with the daemon — decisions made interactively are visible to the autonomous cycle and vice versa
- Agent identity is defined in the repository, ensuring consistency between autonomous and interactive modes
- L0 boundaries apply in interactive sessions — agents never write or modify specifications, even when asked by the operator
```

- [ ] **Step 14: Bump version to 2**

Change `version: 1` to `version: 2` in frontmatter.

- [ ] **Step 15: Commit**

```bash
git add .specify/functional/product-owner.md
git commit -m "spec(L1): add finding approval gate and interactive sessions to FUNC-AC-PRODUCT-OWNER (v2)"
```

---

### Task 4: Update FUNC-AC-QUALITY — Finding Lifecycle Completeness

**Files:**
- Modify: `.specify/functional/quality-assurance.md`

The existing scenario describes the intended flow but frames it as a single step. Now that triage is a distinct phase, the spec should reference the triage lifecycle explicitly and preserve the Operator approval requirement.

- [ ] **Step 16: Update the "Proactive review work detection boundary" scenario**

Replace the existing scenario (located in the "Proactive codebase review" subsection, titled "Proactive review work detection boundary") with:

```markdown
**Scenario: Proactive review work detection boundary**
- Given the proactive review agent has created a finding
- When the work detection system scans for executable work
- Then it excludes untriaged review findings from the executable scan
- And findings follow the triage lifecycle: Tech Lead triages (approve/reject/promote/defer) → PO recommends or rejects → Operator confirms → finding becomes executable work
- And findings labeled `auto-fix-approved` by the Operator bypass the triage lifecycle entirely
```

- [ ] **Step 17: Commit**

```bash
git add .specify/functional/quality-assurance.md
git commit -m "spec(L1): update finding lifecycle to reference triage in FUNC-AC-QUALITY"
```

---

### Task 5: Create GitHub Issues for L2 Pipeline

**Files:** None (GitHub API only)

After specs are committed, create feature-pipeline issues to drive L2 spec generation through the existing pipeline.

- [ ] **Step 18: Create issue for FUNC-AC-TECH-LEAD v2 L2 generation**

Note: Use `l1-approved` only after the operator has reviewed the spec changes. If committing without explicit review, use `feature-pipeline` only and let the operator add `l1-approved` after review.

```bash
gh issue create \
  --title "Generate L2 architecture spec for FUNC-AC-TECH-LEAD v2 (finding triage)" \
  --label "feature-pipeline" \
  --body "FUNC-AC-TECH-LEAD v2 adds finding triage scenarios. Once L1 is operator-approved, generate or update ARCH-AC-TECH-LEAD to cover triage decision mechanics, daily cap enforcement, and integration with the finding approval gate and work-detection."
```

- [ ] **Step 19: Create issue for FUNC-AC-PRODUCT-OWNER v2 L2 generation**

```bash
gh issue create \
  --title "Generate L2 architecture spec for FUNC-AC-PRODUCT-OWNER v2 (finding approval + interactive sessions)" \
  --label "feature-pipeline" \
  --body "FUNC-AC-PRODUCT-OWNER v2 adds finding approval gate, needs-discussion queue, Operator confirmation step, and interactive agent sessions. Once L1 is operator-approved, generate or update ARCH-AC-PRODUCT-OWNER to cover approval mechanics, shared persistent state contract, and daemon-to-interactive state synchronization."
```

- [ ] **Step 20: Commit plan docs and close**

```bash
git add docs/superpowers/plans/2026-03-24-finding-triage-and-interactive-agents.md
git commit -m "docs: add finding triage and interactive agents spec plan"
```
