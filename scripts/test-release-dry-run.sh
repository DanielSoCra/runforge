#!/usr/bin/env bash
# scripts/test-release-dry-run.sh — verifies release.sh --dry-run is a ZERO-side-effect preview.
# Sets up a throwaway git repo (main, clean, in sync with a bare origin), stubs launchctl/gh so
# any accidental call is detectable, runs `release.sh --dry-run`, and asserts: exit 0, prints the
# preview + "DRY RUN", creates NO tag, and never invokes launchctl or gh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_SH="$SCRIPT_DIR/release.sh"
WORK="$(mktemp -d)"
STUBS="$(mktemp -d)"
SENTINEL="$WORK/side-effect"
cleanup() { rm -rf "$WORK" "$STUBS"; }
trap cleanup EXIT

# Stubs that record any invocation — a dry run must call NEITHER.
for cmd in launchctl gh; do
  cat > "$STUBS/$cmd" <<STUB
#!/usr/bin/env bash
echo "$cmd called" >> "$SENTINEL"
exit 0
STUB
  chmod +x "$STUBS/$cmd"
done

# Throwaway repo: main, one commit, a bare origin, in sync.
origin="$WORK/origin.git"; repo="$WORK/repo"
git init -q --bare "$origin"
git init -q "$repo"; cd "$repo"
git config user.email t@example.test; git config user.name tester
echo hi > f.txt; git add f.txt; git commit -q -m "initial"
git branch -M main
git remote add origin "$origin"; git push -q origin main
# NB: no `git fetch` here — release.sh uses read-only `git ls-remote`, so the dry run must not
# create .git/FETCH_HEAD (asserted below).

set +e
out="$(PATH="$STUBS:$PATH" bash "$RELEASE_SH" --dry-run 2>&1)"
rc=$?
set -e

fail() { echo "FAIL: $1"; echo "--- output ---"; echo "$out"; exit 1; }
[ "$rc" = 0 ] || fail "expected exit 0, got $rc"
echo "$out" | grep -q "DRY RUN" || fail "expected 'DRY RUN' in output"
echo "$out" | grep -q "Release preview" || fail "expected a preview header"
[ -z "$(git tag)" ] || fail "dry run created a tag: $(git tag)"
[ ! -f "$SENTINEL" ] || fail "dry run invoked a side-effect command: $(cat "$SENTINEL")"
[ ! -f .git/FETCH_HEAD ] || fail "dry run performed a git fetch (FETCH_HEAD present) — preview must be read-only"
echo "PASS: release.sh --dry-run is a zero-side-effect preview"
