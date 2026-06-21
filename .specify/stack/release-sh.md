---
id: STACK-AC-RELEASE
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: sh
references: ARCH-AC-RELEASE
code_paths:
  - scripts/release.sh
test_paths:
  - scripts/test-release-dry-run.sh
---

# STACK-AC-RELEASE — release.sh (dry-run-default Operator release gate)

## Pattern

**A fail-closed, dry-run-by-default release shell script.** `scripts/release.sh` is the Operator-invoked Release Tool: it computes what's new since the last release tag, previews the promotion, and — only behind an explicit `--confirm` (the Operator's approval) — tags the release, writes release notes, promotes the launchd-managed checkout, and restarts the daemon onto the new revision. `--dry-run` is the default and previews with zero side effects. Chosen as a shell script (not daemon code) because release is an Operator-run ops action against the launchd-managed checkout, mirroring the existing `install-daemon.sh` / `uninstall-daemon.sh`.

## Key Decisions

- **Dry-run is the default; the live path requires `--confirm`** — an accidental invocation never deploys (enacts FUNC-AC-RELEASE: production changes only on explicit approval).
- **`set -euo pipefail` + preflight guards**: refuse unless on `main`, the tree is clean, and HEAD is in sync with `origin/main`. The sync check uses **read-only `git ls-remote`** (no `fetch`), so a dry run makes ZERO changes (no `FETCH_HEAD`). Under `--confirm`, the record preconditions (git identity + `gh auth`) are verified BEFORE any restart, so a successful promotion is never left unrecorded.
- **Release record = an annotated git tag + a GitHub release** (`gh release create`) carrying the change summary (`git log <last-tag>..HEAD`) — the append-only Release Log.
- **Promotion IS the restart**: the checkout is already at `origin/main` (preflight) and the daemon runs the TS source via `tsx` (no build), so `launchctl kickstart -k` is the promotion — there is no checkout advance to half-apply. The release is **recorded (tag + `gh release`) only AFTER the restart succeeds and the daemon is confirmed loaded** (`launchctl print`), so the Release Log never claims a release that did not happen. On a failed/unhealthy restart the script best-effort **rolls the checkout back to the prior release tag** and restarts, leaving production on the prior release and recording nothing. The live `--confirm` path is a MINIMAL first cut (Operator-run); a heartbeat-based health probe is future work.
- **Daemon-only scope**: releases the native launchd daemon; Docker-backed services (dashboard, briefing-summarizer) + DB migrations are a SEPARATE deploy step the script does not touch (it prints a reminder). A full multi-service release is a future extension.
- Reuses the daemon label + paths from `install-daemon.sh`; introduces no new supervisor.

## Examples

```sh
# default: preview only, zero side effects
echo "=== Release preview (since ${prev:-none}) ==="; git log --oneline "$range"
# the live path is gated behind explicit confirmation
[ "$CONFIRM" = 1 ] || { echo "DRY RUN — pass --confirm to release"; exit 0; }
git tag -a "$next_tag" -m "Release $next_tag"   # ...then gh release + pull + kickstart
```

## Gotchas

- **Never mutate on a dry run** — the `--confirm` gate wraps every mutating step (tag, push, gh release, pull, kickstart). A preview makes zero changes (asserted by `test-release-dry-run.sh`: no new tag, no `launchctl`).
- **Fail closed on preflight** — a dirty tree / wrong branch / behind-origin aborts before any tag or restart.
- **Restart failure must leave the prior daemon running** — rely on launchd `KeepAlive`; never leave the daemon stopped.
- **macOS-specific** (`launchctl`): this targets the launchd deployment; another deployment's release path is its own profile concern.
- **Known limitations of the minimal live path (tracked future hardening — the path is Operator-run + gated):** liveness is a shallow `launchctl print` check (a heartbeat-based readiness probe that catches a crash-loop is future work); the record is tag-first (the pushed `release-*` tag is the durable Release Log entry) with `gh release` best-effort + surfaced on failure; and a *first* release (no prior `release-*` tag) has no rollback target, so a failed first restart is surfaced rather than auto-recovered. The prior-release lookup is scoped to `release-*` tags so `archive/*` tags are never mistaken for a release.
