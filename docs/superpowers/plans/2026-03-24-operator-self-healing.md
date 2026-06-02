> **🗄 HISTORICAL (2026-06-02).** Completed/superseded record, kept for provenance — superseded by the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. The canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# Operator Self-Healing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add self-healing (Check 8) and usage throttling to the auto-claude-operator skill so the operator can autonomously diagnose and fix bugs in the auto-claude system, including daemon code changes.

**Architecture:** The implementation is primarily skill-file updates (operator behavior is driven by the SKILL.md reference document) plus one daemon code change to expose `dailyRunCount` in the `/status` endpoint. The operator is a Claude Code session that reads the skill and follows its procedures.

**Tech Stack:** Markdown (skill file), TypeScript (daemon status endpoint), Bash (operator commands)

---

### Task 1: Add `dailyRunCount` to daemon `/status` endpoint

The operator needs to know how many runs happened today to enforce the usage budget cap. Add a counter to the daemon that tracks daily run count and exposes it via `/status`.

**Files:**
- Modify: `packages/daemon/src/control-plane/daemon.ts`
- Modify: `packages/daemon/src/control-plane/daemon.test.ts`

- [ ] **Step 1: Add `dailyRunCount` state variable**

In `daemon.ts`, near the existing `activeRuns` variable (around line 354), add:

```typescript
let dailyRunCount = 0;
let dailyRunCountResetDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD UTC
```

- [ ] **Step 2: Increment on run start, reset daily**

In the `processWorkRequest` function entry (around line 685), add:

```typescript
// Reset daily counter if date changed (UTC calendar day)
const today = new Date().toISOString().split('T')[0];
if (today !== dailyRunCountResetDate) {
  dailyRunCount = 0;
  dailyRunCountResetDate = today;
}
dailyRunCount++;
```

- [ ] **Step 3: Expose in `/status` response**

In the server handlers object (where `activeRuns`, `dailyCost`, `paused` etc. are returned), add `dailyRunCount`:

```typescript
status: () => ({
  activeRuns,
  dailyCost: costTracker.getDailyCost(),
  paused,
  consecutiveStuckCount,
  uptime: (Date.now() - startTime) / 1000,
  dailyRunCount,
  ...safeState,
}),
```

- [ ] **Step 4: Add test for dailyRunCount**

Add a test to `daemon.test.ts` that verifies the status endpoint returns `dailyRunCount`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @auto-claude/daemon test`
Expected: All tests pass

- [ ] **Step 6: Verify changes look correct**

Do NOT commit yet — Task 5 handles the final commit for all changes.

---

### Task 2: Add Check 8 (Self-Healing) to operator skill

Add the complete self-healing procedure as Check 8 in the operator skill. This is the core implementation — the skill document IS the code (it drives Claude Code's behavior).

**Files:**
- Modify: `~/.claude/skills/auto-claude-operator/SKILL.md`

- [ ] **Step 1: Update skill description**

Update the frontmatter description to include self-healing:

```yaml
description: Use when operating, monitoring, deploying, updating, or troubleshooting the auto-claude autonomous development system — daemon lifecycle, dashboard, operator loop, self-deployment, self-healing, usage throttling, Supabase migrations, health checks, launchd, docker compose
```

- [ ] **Step 2: Update "Operator Loop" header**

Change `## Operator Loop (8-Check Cycle)` to `## Operator Loop (9-Check Cycle)`.

- [ ] **Step 3: Rename old Check 8 to Check 9**

Change `### Check 8: Status Summary` to `### Check 9: Status Summary`.

- [ ] **Step 4: Add Check 8 (Self-Healing) section**

Insert before Check 9, after Check 7. Full content:

```markdown
### Check 8: Self-Healing

Diagnose and fix bugs in auto-claude itself. One fix per cycle max. See full spec: `docs/superpowers/specs/2026-03-24-operator-self-healing-design.md`

**Step 1: Collect signals**
```bash
# Cheap signals (every cycle)
tail -100 ~/logs/claude-daemon.log > /tmp/daemon-signals.txt
docker compose logs briefing-summarizer --tail 50 2>/dev/null >> /tmp/daemon-signals.txt
# Check for stuck run patterns
curl -s http://127.0.0.1:3847/status | jq .consecutiveStuckCount
```

Parse for: error messages, stack traces, Zod validation failures, "column does not exist", rate-limit signals, repeated stuck runs on the same issue.

**Expensive signals (hourly throttle):**
Only run if `~/logs/operator-last-test-run` is older than 1 hour:
```bash
pnpm --filter @auto-claude/daemon test 2>&1 | tail -20
pnpm --filter @auto-claude/daemon typecheck 2>&1 | tail -10
date -u +%Y-%m-%dT%H:%M:%SZ > ~/logs/operator-last-test-run
```

If no errors found in any signal → skip to Check 9.

**Step 2: Diagnose**
- Grep codebase for the error source
- Trace root cause
- Determine proposed fix and which files to change
- If diagnosis unclear → skip, don't guess

**Step 3: Safety checks (preamble)**
Before applying ANY fix, verify ALL of these:

1. **Lock:** `~/logs/operator-self-heal.lock` — if exists AND < 30 min old, skip. If > 30 min, treat as stale.
2. **Cooldown:** If any fix was applied in last 2 cycles (~20 min), skip.
3. **Daily limit:** Count fixes today in `~/logs/operator-self-heal.log`. If >= 5, skip.
4. **Dedup:** Check if this error key (file:normalized-message) was attempted 3+ times today. If so, open GitHub Issue with `needs-human` label and skip.
5. **Path guard:** Abort if fix touches ANY of:
   - `.specify/functional/` (L1 specs)
   - `~/.claude/skills/auto-claude-operator/` (this skill)
   - `.env.mac`, `.env.prod` (secrets)
   - `package.json`, `*/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json`
6. **Per-file cooldown:** If target file was self-healed in last 3 cycles, skip.

**Step 4: Apply fix**

Create lock file with timestamp. Then branch:
```bash
git checkout -b self-heal/$(date +%s) dev
```

**If fix does NOT touch `packages/daemon/src/` (no restart):**
1. Edit files, commit: `git add <files> && git commit -m "fix(self-heal): <description>"`
2. Run tests: `pnpm --filter <affected-package> test`
3. If tests FAIL → push branch, `git checkout dev`, open PR (`gh pr create`), delete local branch, release lock
4. If tests PASS → rebuild service if needed, verify via Playwright
5. If verification FAILS → `git checkout dev`, push branch, open PR, release lock
6. If verification PASSES → `git checkout dev && git merge self-heal/<ts>`, delete branch, release lock

**If fix touches `packages/daemon/src/` (daemon restart):**
1. Pause daemon: `curl -X POST http://127.0.0.1:3847/pause -H "X-Requested-By: cli"`
2. Wait for `activeRuns == 0` (poll 5s, max 5 min). If timeout → abort, resume, release lock. After 3 consecutive timeouts → open Issue `needs-human`.
3. Edit files, commit on branch
4. Run tests: `pnpm --filter @auto-claude/daemon test`
5. If tests FAIL → `git checkout dev`, resume daemon, push branch, open PR, release lock
6. If tests PASS → `git checkout dev && git merge self-heal/<ts>`, restart daemon (`launchctl unload/load`), wait 30s, check `/status`
7. If health FAILS → `git revert HEAD --no-edit`, restart daemon, push fix branch, open PR, release lock
8. If health PASSES → resume daemon, delete branch, release lock

**Step 5: Log**

Append to `~/logs/operator-self-heal.log`:
```
[<ISO timestamp>] [self-heal]
  Key: <file:normalized-error>
  Signal: <source — which log/check found it>
  Diagnosis: <root cause>
  Files: <changed files>
  Tier: <no-restart|daemon-restart>
  Outcome: <fixed|failed-tests-pr-opened|failed-health-pr-opened|skipped-dedup|skipped-limit>
```
```

- [ ] **Step 5: Commit skill update**

```bash
# Skills are outside the repo, so just verify the file is saved
cat ~/.claude/skills/auto-claude-operator/SKILL.md | head -5
```

---

### Task 3: Add Usage Throttling to Check 6

Add rate-limit detection and run budget caps to the existing system health check.

**Files:**
- Modify: `~/.claude/skills/auto-claude-operator/SKILL.md`

- [ ] **Step 1: Add usage throttling section to Check 6**

After the existing dashboard checks in Check 6, add:

```markdown
**Usage throttling (Max subscription protection):**
```bash
# Run budget cap — check daily and hourly run counts
DAILY_RUNS=$(curl -s http://127.0.0.1:3847/status | jq '.dailyRunCount // 0')
# Hourly: count runs started in last hour from Supabase
HOURLY_RUNS=$(source .env.mac && curl -s "${SUPABASE_URL}/rest/v1/runs?select=id&started_at=gte.$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
```
- If `DAILY_RUNS >= 15` → pause daemon, log `[usage] Daily limit (15) reached`
- If `HOURLY_RUNS >= 3` → pause daemon, log `[usage] Hourly limit (3) reached`, resume after hour rolls over

**Rate limit detection:**
- Check daemon logs for `Rate limited` or `cooling down` messages
- Check for 3+ stuck runs with empty output (CLI session limit signal)
- If detected → pause daemon for 15 min, log `[usage] Rate limit detected`
- If rate-limited 3+ times today → pause daemon for rest of day
```

- [ ] **Step 2: Commit skill update**

Verify file saved correctly.

---

### Task 4: Update operator loop cron prompt

Update the cron prompt template in the skill to include Checks 8 and 9.

**Files:**
- Modify: `~/.claude/skills/auto-claude-operator/SKILL.md`

- [ ] **Step 1: Update the cron prompt example in the skill**

The skill should document the full 9-check cron prompt so new operator sessions know what to create. Add a section near the top:

```markdown
## Starting the Operator Loop

Create a 10-minute cron via CronCreate with this prompt:

OPERATOR LOOP — Run the 9-check cycle using the auto-claude-operator skill. Make all decisions autonomously. L1 specs are sacred — NEVER modify them.

Checks: (1) Pipeline Health, (2) L2 Spec Review, (3) PR Review & Merge, (4) P2 Triage, (5) Stale Cleanup, (6) System Health + Usage Throttling, (7) Dashboard Playwright Verification, (8) Self-Healing, (9) Status Summary.
```

- [ ] **Step 2: Commit**

---

### Task 5: Deploy and verify

- [ ] **Step 1: Restart daemon to pick up `dailyRunCount` change**

```bash
launchctl unload ~/Library/LaunchAgents/com.autoclaude.daemon.plist 2>/dev/null
sleep 2
launchctl load ~/Library/LaunchAgents/com.autoclaude.daemon.plist
sleep 5
curl -s http://127.0.0.1:3847/status | jq .dailyRunCount
```

Expected: `0` (or a number if runs happened since restart)

- [ ] **Step 2: Verify skill loads correctly**

Start a fresh Claude Code session and type:
```
/auto-claude-operator
```

Verify Check 8 (Self-Healing) and usage throttling sections are visible.

- [ ] **Step 3: Run one operator loop cycle manually**

Ask the operator to run the 9-check cycle. Verify:
- Checks 1-7 work as before
- Check 8 collects signals and reports "no issues found" (or finds and handles an issue)
- Check 9 outputs status summary
- Usage throttling in Check 6 reports daily/hourly run counts

- [ ] **Step 4: Commit daemon changes**

Note: Skill file changes (`~/.claude/skills/auto-claude-operator/SKILL.md`) live outside the repo and are not committed. Only daemon code changes go into git.

```bash
git add packages/daemon/src/control-plane/daemon.ts packages/daemon/src/control-plane/daemon.test.ts
git commit -m "feat(daemon): expose dailyRunCount in /status endpoint for operator usage throttling

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
