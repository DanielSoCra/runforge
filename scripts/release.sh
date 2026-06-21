#!/usr/bin/env bash
# scripts/release.sh — Operator-approved production release (FUNC-AC-RELEASE / STACK-AC-RELEASE).
#
# DRY-RUN BY DEFAULT: previews what a release would do with ZERO side effects. The live promotion
# (annotated tag + GitHub release + ff-pull + daemon restart) happens ONLY with --confirm, which
# stands for the Operator's explicit per-release approval. Fail-closed: refuses unless on main,
# the working tree is clean, and HEAD is in sync with origin/main.
set -euo pipefail

DAEMON_LABEL="com.autoclaude.daemon"

CONFIRM=0
for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM=1 ;;
    --dry-run) CONFIRM=0 ;;
    *) echo "usage: release.sh [--dry-run|--confirm]" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

# Preflight — fail closed on an unclean or stale Ready State.
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || { echo "ERROR: releases happen from main (currently on '$branch')" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "ERROR: working tree is not clean" >&2; exit 1; }
# Read-only sync check — a dry run must make ZERO changes, not even a fetch (no FETCH_HEAD /
# remote-tracking ref writes). `git ls-remote` reads the remote without mutating anything.
remote_main="$(git ls-remote origin refs/heads/main 2>/dev/null | awk 'NR==1{print $1}')"
[ -n "$remote_main" ] || { echo "ERROR: could not read origin/main" >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$remote_main" ] || {
  echo "ERROR: local main is not in sync with origin/main" >&2; exit 1;
}

# Only release-* tags count as prior releases — ignore archive/* and other tags so the preview
# range and the rollback target are anchored to the last PRODUCTION release, not an unrelated tag.
prev="$(git describe --tags --abbrev=0 --match 'release-*' 2>/dev/null || true)"
range="${prev:+${prev}..}HEAD"
next_tag="release-$(git rev-parse --short HEAD)"

echo "=== Release preview (changes since ${prev:-'(no prior release)'}) ==="
git log --oneline "$range" || true
echo "would tag:            $next_tag"
echo "would restart daemon: $DAEMON_LABEL"

if [ "$CONFIRM" != "1" ]; then
  echo "DRY RUN — no changes made. Re-run with --confirm to release (Operator approval)."
  exit 0
fi

# ---- live promotion (Operator-approved via --confirm) ----
# MINIMAL first cut, run by the Operator. The checkout is already at origin/main (preflight) and
# the daemon runs the TS source via tsx (no build), so PROMOTION IS THE RESTART. A production-grade
# health probe (heartbeat-based) and multi-service (Docker/migrations) deploy are future work.
echo "=== Releasing $next_tag (Operator-approved) ==="

# Record-precondition preflight: verify we CAN record BEFORE mutating production, so a successful
# promotion is never left unrecorded (FUNC-AC-RELEASE: every release recorded).
git config user.email >/dev/null 2>&1 || { echo "ERROR: git identity unset; cannot tag — aborting before any restart." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh is not authenticated; cannot record the release — aborting before any restart." >&2; exit 1; }

target="gui/$(id -u)/${DAEMON_LABEL}"
if ! launchctl kickstart -k "$target" || ! launchctl print "$target" >/dev/null 2>&1; then
  echo "ERROR: daemon did not come up after restart." >&2
  if [ -n "$prev" ]; then
    echo "Rolling back the checkout to the prior release $prev and restarting." >&2
    git checkout -q "$prev" && launchctl kickstart -k "$target" || true
  fi
  echo "Production left on the prior release; NOT recording a release. Investigate." >&2
  exit 1
fi

# Promotion succeeded -> record the release (preconditions already verified above).
notes="$(git log --pretty='- %s' "$range")"
git tag -a "$next_tag" -m "Release $next_tag"
git push origin "$next_tag"
gh release create "$next_tag" --title "$next_tag" --notes "$notes" \
  || echo "ERROR: 'gh release create' failed after promotion; the tag is pushed (the record exists) — add the GitHub release note manually to complete it." >&2
echo "Released $next_tag (daemon restarted)."
echo "NOTE: daemon-only release. Docker-backed services (dashboard, briefing-summarizer) + DB" >&2
echo "      migrations are a SEPARATE deploy step this script does not touch (future extension)." >&2
