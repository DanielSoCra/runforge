#!/usr/bin/env bash
#
# smoke-engine.sh — one-command operational smoke for the containerized engine.
#
# Proves the live engine can take a fresh `feature-pipeline` issue from seed to
# the first human gate: detect -> l2-design -> open L2 proposal PR -> PARK at the
# l2-gate (emit a `decision-request`). That single transition exercises the whole
# critical path: container health, git credentials, subscription-token auth,
# the worker (l2-designer) adapter, artifact delivery, PR creation, and the gate
# park. If it reaches the gate, the engine is alive end-to-end up to the point
# where a human decision is required.
#
# This is a SMOKE test, not a unit test: it talks to real Docker, real GitHub,
# and the real model API, and it costs tokens. It is meant to be run by the
# operator (or a nightly job), NOT in PR CI. The deterministic phase-transition
# coverage lives in `src/control-plane/phases.test.ts` (incl. the #49 auto-merge).
#
# THE #1 FAILURE MODE is an expired subscription token: a worker silently gets a
# 401 and the run goes `stuck`. So this script does a TOKEN PREFLIGHT first —
# it (optionally) re-syncs creds and verifies they actually authenticate against
# the API BEFORE seeding anything. A dead token fails loudly here, up front.
#
# Usage:
#   bash packages/daemon/scripts/smoke-engine.sh            # full smoke
#   SMOKE_PREFLIGHT_ONLY=1 bash .../smoke-engine.sh         # only health+token preflight
#   SMOKE_DRY_RUN=1 bash .../smoke-engine.sh                # print the plan, touch nothing
#   SMOKE_KEEP=1 bash .../smoke-engine.sh                   # leave the seeded issue in place
#
# Config (env, with pilot defaults):
#   SMOKE_REPO         GitHub owner/name to run against   (default DANIELSOCRAHANDLEZZ/runforge-example)
#   SMOKE_SPEC_KEY     L1 spec to ladder to L2            (default FUNC-NOTES-DIGEST)
#   SMOKE_CONTAINER    daemon container name              (default runforge-daemon-1)
#   SMOKE_CONTROL_URL  control-plane base URL             (default http://localhost:3847)
#   SMOKE_CREDS_DIR    host dir mounted to /root/.claude  (default /tmp/pilot-claude)
#   SMOKE_SYNC_SCRIPT  optional creds re-sync script      (default scripts/sync-claude-creds.sh if present)
#   SMOKE_TIMEOUT      seconds to wait for the gate       (default 900)
#   SMOKE_POLL         poll interval seconds              (default 15)
#
set -uo pipefail

REPO="${SMOKE_REPO:-DANIELSOCRAHANDLEZZ/runforge-example}"
SPEC_KEY="${SMOKE_SPEC_KEY:-FUNC-NOTES-DIGEST}"
CONTAINER="${SMOKE_CONTAINER:-runforge-daemon-1}"
CONTROL_URL="${SMOKE_CONTROL_URL:-http://localhost:3847}"
CREDS_DIR="${SMOKE_CREDS_DIR:-/tmp/pilot-claude}"
TIMEOUT="${SMOKE_TIMEOUT:-900}"
POLL="${SMOKE_POLL:-15}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYNC_SCRIPT="${SMOKE_SYNC_SCRIPT:-$REPO_ROOT/scripts/sync-claude-creds.sh}"

c_red()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
step()   { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }
fail()   { c_red "SMOKE FAIL: $*"; exit 1; }

ts() { date -u +%H:%M:%SZ; }

step "config"
echo "repo=$REPO spec=$SPEC_KEY container=$CONTAINER control=$CONTROL_URL"
echo "creds_dir=$CREDS_DIR timeout=${TIMEOUT}s poll=${POLL}s"
if [ -n "${SMOKE_DRY_RUN:-}" ]; then
  c_ylw "DRY RUN — would: preflight(health,token) -> seed feature-pipeline+l1-approved issue laddering $SPEC_KEY -> wait <= ${TIMEOUT}s for decision-request -> report"
  exit 0
fi

# --- preflight: tooling ---
step "preflight: tooling"
command -v docker >/dev/null || fail "docker not found on PATH"
command -v gh     >/dev/null || fail "gh (GitHub CLI) not found on PATH"
command -v python3>/dev/null || fail "python3 not found on PATH"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated (run: gh auth login)"
c_grn "tooling OK"

# --- preflight: container health ---
step "preflight: daemon container health"
state=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null) \
  || fail "container '$CONTAINER' not found — bring up the daemon first (docker compose ... up -d daemon)"
[ "$state" = "running" ] || fail "container '$CONTAINER' is '$state', expected 'running'"
health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)
echo "container state=$state health=$health"
hc=$(curl -s -o /dev/null -w '%{http_code}' "$CONTROL_URL/health" 2>/dev/null || echo 000)
[ "$hc" = "200" ] || fail "control-plane $CONTROL_URL/health returned HTTP $hc (expected 200)"
degraded=$(curl -s "$CONTROL_URL/health" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("degraded"))' 2>/dev/null)
[ "$degraded" = "True" ] && c_ylw "WARNING: /health reports degraded=true"
c_grn "container healthy, control-plane reachable"

# --- preflight: TOKEN (the #1 failure mode) ---
step "preflight: subscription token (re-sync + auth check)"
if [ -x "$SYNC_SCRIPT" ]; then
  echo "re-syncing creds via $SYNC_SCRIPT"
  RUNFORGE_CREDS_DIR="$CREDS_DIR" "$SYNC_SCRIPT" 2>&1 | tail -1 || c_ylw "sync script returned non-zero (continuing to auth check)"
else
  c_ylw "no sync script at $SYNC_SCRIPT — relying on existing creds at $CREDS_DIR"
fi
[ -f "$CREDS_DIR/.credentials.json" ] || fail "no creds at $CREDS_DIR/.credentials.json"
auth=$(CREDS_DIR="$CREDS_DIR" python3 - <<'PY'
import json,os,time,urllib.request,urllib.error
p=os.path.join(os.environ["CREDS_DIR"],".credentials.json")
o=json.load(open(p)); o=o.get("claudeAiOauth",o)
tok=o.get("accessToken"); exp=o.get("expiresAt")
if exp:
    mins=int((exp/1000-time.time())/60)
    print(f"expiry_min={mins}")
    if mins<5: print("RESULT=EXPIRED"); raise SystemExit
if not tok: print("RESULT=NOTOKEN"); raise SystemExit
body=json.dumps({"model":"claude-haiku-4-5-20251001","max_tokens":16,
  "system":"You are Claude Code, Anthropic's official CLI for Claude.",
  "messages":[{"role":"user","content":"Reply with exactly: AUTH_OK"}]}).encode()
req=urllib.request.Request("https://api.anthropic.com/v1/messages",data=body,headers={
  "authorization":f"Bearer {tok}","anthropic-version":"2023-06-01",
  "anthropic-beta":"oauth-2025-04-20","content-type":"application/json"})
try:
    r=urllib.request.urlopen(req,timeout=30)
    txt="".join(b.get("text","") for b in json.load(r).get("content",[]))
    print("RESULT=OK" if "AUTH_OK" in txt else f"RESULT=UNEXPECTED:{txt!r}")
except urllib.error.HTTPError as e:
    print(f"RESULT=HTTP{e.code}:{e.read().decode()[:120]}")
except Exception as e:
    print(f"RESULT=ERR:{type(e).__name__}:{str(e)[:120]}")
PY
)
echo "$auth"
echo "$auth" | grep -q "RESULT=OK" || fail "token does NOT authenticate — re-sync a fresh subscription token before running the engine ($auth)"
c_grn "token authenticates"

if [ -n "${SMOKE_PREFLIGHT_ONLY:-}" ]; then
  c_grn "PREFLIGHT OK (health + token). Skipping seed (SMOKE_PREFLIGHT_ONLY=1)."
  exit 0
fi

# --- seed ---
step "seed: fresh feature-pipeline issue"
title="smoke: ladder $SPEC_KEY to L2 ($(date -u +%Y%m%d-%H%MZ))"
body="Ladder $SPEC_KEY to an L2 architecture and park at the l2-gate for Operator approval. Spec chain in .specify/. (automated engine smoke — safe to close)"
url=$(gh issue create --repo "$REPO" --title "$title" --body "$body" \
  --label feature-pipeline --label l1-approved 2>&1 | grep -oE 'https://[^ ]+/issues/[0-9]+') \
  || fail "could not create issue (labels feature-pipeline/l1-approved must exist on $REPO)"
N=$(echo "$url" | grep -oE '[0-9]+$')
c_grn "seeded #$N — $url"

cleanup() {
  if [ -z "${SMOKE_KEEP:-}" ] && [ -n "${N:-}" ]; then
    gh issue edit "$N" --repo "$REPO" --remove-label feature-pipeline >/dev/null 2>&1 \
      && echo "cleaned up: removed feature-pipeline from #$N (issue left open; SMOKE_KEEP=1 to skip)"
  fi
}
trap cleanup EXIT

# --- wait for the gate ---
step "wait: up to ${TIMEOUT}s for #$N to park at the l2-gate"
deadline=$(( $(date +%s) + TIMEOUT ))
prev=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  labels=$(gh issue view "$N" --repo "$REPO" --json labels --jq '[.labels[].name]|sort|join(",")' 2>/dev/null)
  if [ "$labels" != "$prev" ]; then echo "[$(ts)] labels=[$labels]"; prev="$labels"; fi
  case ",$labels," in
    *,decision-request,*) c_grn "PARKED at l2-gate (decision-request emitted)"
      pr=$(gh pr list --repo "$REPO" --state open --search "in:title #$N" --json number,headRefName --jq '.[]|"#\(.number) (\(.headRefName))"' 2>/dev/null | head -1)
      [ -n "$pr" ] && echo "L2 proposal PR: $pr"
      c_grn "SMOKE PASS — engine reached the first human gate end-to-end."
      exit 0 ;;
    *,stuck,*|*,failed,*) c_red "run hit a failure label: [$labels]"
      step "diagnostics: recent daemon log"
      docker logs "$CONTAINER" --since 300s 2>&1 | grep -viE "POST /repos.*labels - 422" | tail -25
      fail "run did not reach the gate (failure label)" ;;
  esac
  sleep "$POLL"
done
step "diagnostics: recent daemon log (timeout)"
docker logs "$CONTAINER" --since "${TIMEOUT}s" 2>&1 | grep -viE "POST /repos.*labels - 422" | tail -25
fail "timed out after ${TIMEOUT}s without reaching the l2-gate"
