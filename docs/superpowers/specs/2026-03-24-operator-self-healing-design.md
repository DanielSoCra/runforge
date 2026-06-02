> **⛔ SUPERSEDED (2026-06-02).** This design doc's still-valid content has been folded into the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. Retained for history; the canonical specs in `.specify/` govern — do not act on it as a live instruction. See the Spec Reconciliation Ledger (`docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`). <!-- RECONCILIATION-LEDGER-BANNER -->

# Operator Self-Healing Design

**Date:** 2026-03-24
**Status:** Draft
**Author:** Claude (brainstormed with the Operator)

## Problem

The auto-claude operator loop detects infrastructure and pipeline failures but cannot fix code-level bugs autonomously. When the briefing-summarizer queries a nonexistent column, when the dashboard crashes due to a null guard, or when the daemon's phase handlers are missing — a human must intervene. This slows iteration during the early development/testing phase.

## Solution

Add Check 8 (Self-Healing) to the `auto-claude-operator` skill (renumber old Check 8 "Status Summary" to Check 9). The operator reads system signals, diagnoses issues, classifies risk, and applies fixes — including daemon source code changes. Safety comes from automated testing, deploy-then-verify with automatic rollback, and rate limiting.

## Signal Collection

Check 8 runs after Check 7 (dashboard verification) in each operator loop cycle.

**Every cycle (cheap):**
- AI Briefing content (from Check 7 Playwright snapshot)
- Daemon logs: `tail -100 ~/logs/claude-daemon.log`
- Briefing-summarizer logs: `docker compose logs briefing-summarizer --tail 50`
- Stuck run patterns: same issue stuck 3+ times indicates a systemic bug

**Hourly throttle (expensive):**
- Test suite: `pnpm --filter @auto-claude/daemon test`
- TypeScript check: `pnpm --filter @auto-claude/daemon typecheck`
- Tracked via timestamp file: `~/logs/operator-last-test-run` (single timestamp, overwritten each run)

## Diagnosis Flow

1. Parse signals for errors (stack traces, Zod validation failures, HTTP errors, column-not-found, etc.)
2. Grep codebase for error source
3. Determine root cause and proposed fix
4. If no issues found, skip — done

## Issue Deduplication

The operator tracks attempted fixes by a deduplication key: **file path + normalized error message** (with variable parts like timestamps, UUIDs, and request IDs stripped). This key is logged in `~/logs/operator-self-heal.log` and checked before each fix attempt. If the same key has been attempted 3 times in the current day, the operator opens a GitHub Issue tagged `needs-human` and stops retrying.

## Risk Classification

Two tiers based on whether the fix requires a daemon restart:

| Tier | Criteria | Examples |
|------|----------|---------|
| **No restart** | Fix does not touch `packages/daemon/src/` | Dashboard components, briefing-summarizer, config files, docker-compose.yml, prompts, Supabase data |
| **Daemon restart** | Fix touches any file in `packages/daemon/src/` | Phase handlers, work detection, run-writer, types, runtime |

## Fix Procedure: Common Preamble

Before applying any fix:

1. **Acquire lock:** Check `~/logs/operator-self-heal.lock`. If held AND less than 30 minutes old, skip self-healing this cycle. If held but older than 30 minutes, treat as stale (operator crashed mid-fix) and overwrite. Otherwise, create it with current timestamp.
2. **Cooldown check:** If a fix was applied within the last 2 cycles (20 min), skip self-healing to let signals stabilize.
3. **Daily limit:** If 5 or more fixes have been applied today, skip self-healing and log a warning.
4. **Path guard:** Verify no changed file matches forbidden paths. If any match, abort the fix. Forbidden paths:
   - `.specify/functional/` — L1 specs
   - `~/.claude/skills/auto-claude-operator/` — operator skill
   - `.env.mac`, `.env.prod` — secrets
   - `package.json`, `*/package.json` — dependency manifests
   - `pnpm-lock.yaml`, `pnpm-workspace.yaml` — lockfile and workspace config
   - `tsconfig*.json` — TypeScript configuration
5. **Per-file cooldown:** If any target file was modified by self-healing in the last 3 cycles, skip this fix to avoid conflicting stacked changes.
6. **Branch:** Create a temporary branch: `git checkout -b self-heal/<timestamp> dev`

## Fix Procedure: No Restart Needed

1. Apply fix and commit: `git add <files> && git commit -m "fix(self-heal): <description>"`
2. Run affected package tests: `pnpm --filter <package> test`
3. **If tests FAIL:** Push branch (`git push origin self-heal/<timestamp>`), `git checkout dev`, open PR from the branch for human review, delete local branch
4. **If tests PASS:** Rebuild affected service if needed: `ENV_FILE=.env.mac docker compose --env-file .env.mac up --build -d <service>`
5. Verify via Playwright (load affected pages, check for errors)
6. **If verification FAILS:** `git checkout dev`, push branch, open PR, delete local branch, release lock
7. **If verification PASSES:** `git checkout dev && git merge self-heal/<timestamp>`, delete branch, release lock, log fix

## Fix Procedure: Daemon Restart Needed

1. `curl -X POST http://127.0.0.1:3847/pause -H "X-Requested-By: cli"`
2. Wait for `activeRuns == 0` (poll every 5s, max 5 min). **If drain times out: abort fix, resume daemon, log, release lock.** Do not force-proceed. Track consecutive drain timeouts — after 3 in a row, open GitHub Issue tagged `needs-human` and stop attempting daemon-restart fixes until resolved.
3. Apply fix and commit: `git add <files> && git commit -m "fix(self-heal): <description>"`
4. Run: `pnpm --filter @auto-claude/daemon test`
5. **If tests FAIL:**
   - `git checkout dev` (return to dev, fix stays on branch)
   - Resume daemon: `POST /resume`
   - Push branch: `git push origin self-heal/<timestamp>`
   - Open PR with the attempted fix for human review
   - Log: `[self-heal] FAILED: tests did not pass, PR opened`
   - Release lock
6. **If tests PASS:**
   - `git checkout dev && git merge self-heal/<timestamp>` (merge fix to dev — branch kept until verified)
   - Restart daemon: `launchctl unload ~/Library/LaunchAgents/com.autoclaude.daemon.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/com.autoclaude.daemon.plist`
   - Wait 30s
   - Verify: `curl -s http://127.0.0.1:3847/status` — check `activeRuns` responds, `paused` is false, no immediate crash in logs
7. **If health check FAILS:**
   - `git revert HEAD --no-edit` (create a revert commit — safe with pushed branches and concurrent commits)
   - Restart daemon on reverted code
   - Push fix branch: `git push origin self-heal/<timestamp>`
   - Open PR from the fix branch for human review
   - Delete local branch
   - Log: `[self-heal] FAILED: health check failed after deploy, reverted`
   - Release lock
8. **If health check PASSES:**
   - Resume daemon if still paused
   - Log: `[self-heal] Fixed: <description>`
   - Release lock

## Safety Rules

1. **One fix per cycle.** Never apply multiple fixes in the same operator loop iteration. Fix the highest-impact issue. Re-evaluate remaining issues next cycle.
2. **Always test before deploying.** Both tiers require passing tests for the affected package before deploy.
3. **Max 3 attempts per issue per day.** Same dedup key attempted 3 times → open GitHub Issue tagged `needs-human`, stop retrying.
4. **Max 5 total fixes per day.** Global daily rate limit prevents cascading fix chains.
5. **2-cycle cooldown after any fix.** Skip self-healing for 2 cycles after applying a fix to let signals stabilize. (At 10-min intervals = 20 min cooldown.)
6. **Concurrency lock.** Acquire `~/logs/operator-self-heal.lock` before any fix. If held, skip.
7. **Never modify L1 specs** (`.specify/functional/`). Source of truth for business requirements.
8. **Never modify the operator skill itself** (`~/.claude/skills/auto-claude-operator/`). Enforced by path guard in preamble.
9. **Never modify `.env.mac` secrets.** Tokens, keys, and encryption keys are human-managed.
10. **Never `git push --force`.** All pushes are normal pushes.
11. **Never delete branches with unmerged work.**
12. **Never fix during active runs** if daemon restart is needed. Abort if drain times out.
13. **Log every fix** to `~/logs/operator-self-heal.log` with: timestamp, dedup key, signal source, issue description, files changed, outcome (fixed/failed/pr-opened).
14. **Fix on a temporary branch.** Never commit directly to dev. Merge to dev only after tests pass.

## Logging Format

```
[2026-03-24T12:30:00Z] [self-heal]
  Key: briefing-summarizer/src/signals.ts:column-does-not-exist
  Signal: briefing-summarizer logs — "column runs.updated_at does not exist"
  Diagnosis: signals.ts:95 queries runs.updated_at but column is runs.started_at
  Files: packages/briefing-summarizer/src/signals.ts
  Tier: no-restart
  Outcome: fixed

[2026-03-24T13:00:00Z] [self-heal]
  Key: control-plane/phases.ts:no-handler-for-phase
  Signal: daemon logs — "No handler for phase l2-design, auto-advancing"
  Diagnosis: phases.ts missing l2-design handler, spec pipeline skips to implement
  Files: packages/daemon/src/control-plane/phases.ts
  Tier: daemon-restart
  Outcome: fixed (tests passed, health check passed)
```

## Usage Throttling (Max Subscription Protection)

The daemon and operator share a single Claude Max 20x subscription. Without throttling, the daemon can exhaust the quota, leaving no capacity for interactive Claude Code sessions.

### Mechanism 1: Reactive — Rate Limit Detection

The operator monitors daemon logs and its own session for rate-limit signals:

**Daemon-side signals:**
- Daemon logs: `Rate limited: cooling down for Xs`
- `SessionError.rateLimited` outcomes in run results
- Daemon status: `consecutiveStuckCount` rising with rate-limit errors

**Operator-side signals:**
- The operator's own Claude Code session becomes slow or unresponsive
- Rate-limit errors in operator tool calls

**Action when detected:**
1. Pause daemon: `POST /pause`
2. Log: `[usage] Daemon paused — rate limit detected`
3. Wait 15 minutes, then check again
4. Resume only when rate-limit signals clear
5. If rate-limited 3+ times in a day, pause daemon for the rest of the day

### Mechanism 2: Proactive — Run Budget Cap

Hard caps on daemon activity to reserve quota for interactive use:

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max runs per hour | 3 | Each run spawns 2-5 sessions. 3 runs ≈ 10-15 sessions/hr. |
| Max runs per day | 15 | Leaves ~50% of daily quota for interactive use. |
| Max concurrent runs | 1 | Already configured in `auto-claude.config.json`. |

**Implementation:**
- The operator tracks run count by parsing daemon status and Supabase runs table
- If hourly or daily limit reached: pause daemon, log reason, set resume timer
- Hourly limit: resume after the hour rolls over
- Daily limit: resume at UTC midnight (calendar day, not rolling 24h)

**Operator Check 6 addition:**
```
# Usage check (add to system health)
RUNS_TODAY=$(curl -s http://127.0.0.1:3847/status | jq .dailyRunCount // 0)
if [ $RUNS_TODAY -ge 15 ]; then
  # Pause daemon until midnight
  curl -X POST http://127.0.0.1:3847/pause -H "X-Requested-By: cli"
  echo "[usage] Daily run limit reached ($RUNS_TODAY/15), paused until midnight"
fi
```

**Prerequisite (Phase 0):** The daemon's `/status` endpoint does not currently expose `dailyRunCount`. This must be implemented before Mechanism 2 can work. Two options:
- **Option A (daemon change):** Add a counter incremented in `processWorkRequest`, reset by `costTracker.maybeResetDaily()`, exposed in `/status`.
- **Option B (Supabase query, no daemon change):** Operator queries runs table directly: `SELECT count(*) FROM runs WHERE started_at >= <today UTC midnight>`. This works immediately as a stopgap.

### Recovery from Session Limits

When a Claude Code session (operator or daemon worker) hits the subscription limit mid-session:

1. The CLI adapter returns empty output or a rate-limit error
2. The daemon marks the run as `stuck` (already handled)
3. The operator detects the pattern (3+ stuck runs with rate-limit/empty-output)
4. Operator pauses daemon and waits for quota to replenish
5. After cooldown (15 min minimum), operator resumes and the run retries

## What This Does NOT Cover

- **New features or architectural changes.** Self-healing fixes bugs. It does not add capabilities, write specs, or evolve the pipeline.
- **Performance optimization.** The operator fixes broken things, not slow things.
- **Security hardening.** Security-related changes always go through PR review (the operator classifies security issues as `needs-plan` in Check 4).
- **Database schema changes.** The operator never creates or applies Supabase migrations automatically. A column-not-found error is fixed by changing the query, not the schema.

## Integration

Self-healing is added to the `auto-claude-operator` skill as **Check 8**. The existing status summary becomes **Check 9**. The operator loop prompt is updated to include Check 8.

The check runs every cycle but expensive signals (tests, typecheck) are throttled to once per hour. A typical cycle with no issues adds ~5s of signal collection. A cycle with a fix adds 1-5 minutes depending on whether daemon restart is needed.
