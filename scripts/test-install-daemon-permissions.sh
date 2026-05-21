#!/bin/bash
# Regression test for SEC-33: plist file must be written with 600 permissions (no TOCTOU window).
# Verifies install-daemon.sh uses the mktemp+chmod+mv pattern to avoid world-readable secrets.
set -euo pipefail

PASS=0
FAIL=0

pass() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }

echo "=== SEC-33 regression: plist file permission test ==="

SCRIPT_PATH="$(dirname "$0")/install-daemon.sh"

# Verify mktemp line is present
if grep -q 'mktemp.*PLIST_DST' "$SCRIPT_PATH"; then
  pass "mktemp line found in install-daemon.sh"
else
  fail "mktemp line NOT found — file may be written without pre-restriction"
fi

# Verify chmod 600 is applied to the temp file before secrets are written
if grep -q 'chmod 600.*PLIST_TMP' "$SCRIPT_PATH"; then
  pass "chmod 600 applied to temp file before write"
else
  fail "chmod 600 on temp file NOT found — TOCTOU race window exists"
fi

# Verify chmod appears before the sed redirect (not after)
CHMOD_LINE=$(grep -n 'chmod 600.*PLIST_TMP' "$SCRIPT_PATH" | head -1 | cut -d: -f1)
SED_LINE=$(grep -n '"[$]PLIST_SRC".*>.*"[$]PLIST_TMP"' "$SCRIPT_PATH" | head -1 | cut -d: -f1)

if [ -n "$CHMOD_LINE" ] && [ -n "$SED_LINE" ] && [ "$CHMOD_LINE" -lt "$SED_LINE" ]; then
  pass "chmod 600 (line $CHMOD_LINE) precedes secret write (line $SED_LINE) — no TOCTOU window"
else
  fail "chmod 600 is missing or does not precede the secret write"
fi

# Verify mv is present to atomically rename temp file to final destination
if grep -q 'mv.*PLIST_TMP.*PLIST_DST' "$SCRIPT_PATH"; then
  pass "mv \"\$PLIST_TMP\" \"\$PLIST_DST\" found — atomic rename in place"
else
  fail "mv line NOT found — temp file may not be moved to final destination"
fi

# Functional test: mktemp+chmod+mv produces a 600 file
TMPDIR_TEST=$(mktemp -d)
DEST="$TMPDIR_TEST/test.plist"
TMP=$(mktemp "${DEST}.XXXXXX")
chmod 600 "$TMP"
echo "secret=abc123" > "$TMP"
mv "$TMP" "$DEST"
PERMS=$(stat -f "%Lp" "$DEST" 2>/dev/null || stat -c "%a" "$DEST" 2>/dev/null)
rm -rf "$TMPDIR_TEST"

if [ "$PERMS" = "600" ]; then
  pass "mktemp+chmod+mv produces mode 600 on this platform"
else
  fail "mktemp+chmod+mv produced unexpected mode: $PERMS"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
