#!/usr/bin/env bash
# ==============================================================
# warmup.sh — MANDATORY: prove you are connected to DAYTONA
#
# Run this on YOUR LOCAL MACHINE (your own environment), FIRST.
# It proves you are NOT working locally — every step must reach
# the remote Daytona sandbox through the API.
#
# If you run this and it "works" but never contacted
# https://proxy.zuzu.dev, you are working in the WRONG place.
#
# You MUST paste the FULL output in your first message.
# ==============================================================
set -u

# Pool identity — single source of truth: run/.pool_env (or env override).
if [ -z "${POOL_SID:-}" ] || [ -z "${POOL_API_KEY:-}" ]; then
  _sb="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." 2>/dev/null && pwd)"
  _pe="$_sb/run/.pool_env"
  [ -f "$_pe" ] && source "$_pe"
  if [ -z "${POOL_SID:-}" ] && [ -f "run/.pool_env" ]; then source "run/.pool_env"; fi
fi
SID="${POOL_SID:-3c0d7459-2b26-4630-a381-9b7134b6417b}"
API_KEY="${POOL_API_KEY:-dtn_a89240b5311ca475455011491cca38d3f778ed7e8ff014f122f4d2d9bd00127d}"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.0"
BASE="https://proxy.zuzu.dev/toolbox/$SID"
MARKER="warmup-$(date +%s)"

# ---- command logging (agent analytics) ----
# warmup runs on the agent's machine: log via REST exec into the sandbox log.
LOG_REST="${BASE}/process/execute"
LOG_DIR="/workspace/.agent-logs"
LOG_FILE="${LOG_DIR}/commands.jsonl"

session_id() {
  local f="${SESSION_FILE:-$HOME/.daytona_session}"
  if [[ ! -s "$f" ]]; then
    local id
    id="$(hostname 2>/dev/null || echo host)-$(uuidgen 2>/dev/null || date +%s)-$$"
    mkdir -p "$(dirname "$f")" 2>/dev/null || true
    printf '%s\n' "$id" > "$f" 2>/dev/null || true
  fi
  cat "$f" 2>/dev/null || echo unknown
}

now_ms() { python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo 0; }

log_call() { # $1=tool $2=cmd $3=exit $4=dur_ms $5=op
  local tool="$1" cmd="$2" ec="${3:-0}" dur="${4:-0}" op="${5:-exec}"
  local ts payload b64
  ts=$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"))' 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
  payload=$(python3 -c 'import json,sys; print(json.dumps({"ts":sys.argv[1],"session":sys.argv[2],"tool":sys.argv[3],"op":sys.argv[4],"exit":int(sys.argv[5]),"dur_ms":int(sys.argv[6]),"cmd":sys.argv[7]}))' "$ts" "$(session_id)" "$tool" "$op" "$ec" "$dur" "$cmd" 2>/dev/null) || return 0
  [[ -z "$payload" ]] && return 0
  b64=$(printf '%s' "$payload" | base64 | tr -d '\n')
  curl -s --max-time 10 -X POST "$LOG_REST" \
    -A "$UA" -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
    -d "{\"command\":\"mkdir -p $LOG_DIR && (echo $b64 | base64 -d; echo) >> $LOG_FILE\"}" >/dev/null 2>&1 || true
}
LOG_CMD="warmup.sh $*"; LOG_CMD="${LOG_CMD:0:500}"
LOG_START=$(now_ms)
trap 'log_call "warmup.sh" "${LOG_CMD:-}" "$?" "$(($(now_ms)-LOG_START))" "warmup"' EXIT

echo "=============================================="
echo " WARMUP — proving the LOCAL -> DAYTONA connection"
echo " (run on YOUR machine, must reach proxy.zuzu.dev)"
echo " Marker: $MARKER"
echo "=============================================="

echo ""
echo "── [0] LOCAL hostname (this must NOT be the sandbox) ──"
echo "  local hostname: $(hostname 2>/dev/null || echo unknown)"

echo ""
echo "── [A] DOWNLOAD r.sh + r2.sh from DAYTONA to local ──"
curl -s "$BASE/files/download?path=/workspace/r.sh" -A "$UA" -H "Authorization: Bearer $API_KEY" -o /tmp/r.sh
curl -s "$BASE/files/download?path=/workspace/r2.sh" -A "$UA" -H "Authorization: Bearer $API_KEY" -o /tmp/r2.sh
chmod +x /tmp/r.sh /tmp/r2.sh
echo "  r.sh:  $(wc -c < /tmp/r.sh 2>/dev/null || echo 0) bytes"
echo "  r2.sh: $(wc -c < /tmp/r2.sh 2>/dev/null || echo 0) bytes"
[[ -s /tmp/r.sh && -s /tmp/r2.sh ]] || { echo "  FAIL: could not download helpers"; exit 1; }

echo ""
echo "── [B] EXEC via MCP — must return SANDBOX hostname ──"
OUT=$(/tmp/r.sh "echo DAYTONA_HOST=\$(hostname) && echo DAYTONA_PWD=\$(pwd)" 2>&1)
echo "  $OUT"
echo "  ─> hostname MUST be a2674551-style (sandbox container),"
echo "     NOT your local machine name. If you see your local hostname,"
echo "     you are running commands LOCALLY — that is WRONG."

echo ""
echo "── [C] UPLOAD a marker file from LOCAL via REST File API ──"
echo "marker-$MARKER" > /tmp/warmup_marker.txt
resp=$(curl -s -X POST "$BASE/files/upload?path=/workspace/warmup_marker.txt" \
  -A "$UA" -H "Authorization: Bearer $API_KEY" \
  -F "file=@/tmp/warmup_marker.txt" 2>&1)
echo "  upload exit=$? resp=$resp"

echo ""
echo "── [D] READ-BACK the marker (round-trip proof) ──"
BACK=$(curl -s "$BASE/files/download?path=/workspace/warmup_marker.txt" \
  -A "$UA" -H "Authorization: Bearer $API_KEY" 2>&1)
echo "  uploaded: marker-$MARKER"
echo "  read-back: $BACK"
[[ "$BACK" == "marker-$MARKER" ]] && echo "  MATCH ✓" || { echo "  MISMATCH — file API round-trip failed"; exit 1; }

echo ""
echo "── [E] GIT/COMMIT CHECK — verify Daytona has the PAT, NOT your local machine ──"
echo "  (a) local git remote token presence (should be ABSENT or redacted):"
if git -C . remote -v >/dev/null 2>&1; then
  echo "      local remote: $(git remote get-url origin 2>/dev/null | sed -E 's#//[^@]+@#//REDACTED@#')"
else
  echo "      (no git repo here — fine, you shouldn't commit from local anyway)"
fi
echo "  (b) Daytona gh auth (must be 'arrrrny', NOT your local account):"
GH_OUT=$(/tmp/r.sh "/workspace/sgh api user --jq .login" 2>&1)
echo "      $GH_OUT"
echo "  ─> Commits + pushes + PRs happen ONLY in Daytona. Do NOT commit locally."

echo ""
echo "── [F] READ OPEN ZURAFFA ISSUES via gh (proves GitHub access from DAYTONA) ──"
echo "  Command: /workspace/sgh issue list -R arrrrny/zuraffa --state open --limit 5"
ISSUES=$(/tmp/r.sh "/workspace/sgh issue list -R arrrrny/zuraffa --state open --limit 5 --json number,title --jq '.[] | \"#\" + (.number|tostring) + \" \" + .title'" 2>&1)
echo "  $ISSUES"
echo "  ─> If you see issue numbers/titles, GitHub access from Daytona works."
echo "     If you see an auth error, STOP — report it."

echo ""
echo "── [F2] WORKTREE MODE (when WORKTREE=<path> is set in your brief) ──"
if [ -n "${WORKTREE:-}" ]; then
  WT_OUT=$(/tmp/r.sh "ls -d $WORKTREE 2>/dev/null && echo WT_OK" 2>&1)
  echo "  worktree: $WORKTREE"
  if echo "$WT_OUT" | grep -q "WT_OK"; then
    echo "  WORKTREE OK ✓ — work ONLY in $WORKTREE (your own git worktree);"
    echo "  NEVER touch the shared /workspace checkout (a parallel same-repo agent may own it)."
  else
    echo "  ⚠ WORKTREE not found on the box ($WT_OUT) — STOP and report."
  fi
else
  echo "  (no WORKTREE set — single mode: work in /workspace/<repo> as usual)"
fi

echo ""
echo "── [G] WSS token delivery (shared) + r2.sh round-trip ──"
# Deliver the SHARED 24h SSH/WSS token to this agent's ~/.r2_token so r2.sh
# works for the whole 24h without any R2_SSH_TOKEN export. The token is
# fetched FROM the box (/root/.r2_shared_token) — the delegator-minted shared
# token. We NEVER mint a per-agent token: a new mint would invalidate the
# shared one and break every other live agent. token.sh get only reuses the
# valid shared token (it mints only at the natural 24h rollover).
TOK=""
if [[ -z "$TOK" ]]; then
  TOK=$(/tmp/r.sh "cat /home/daytona/.r2_shared_token" 2>&1 | grep -oE '[A-Za-z0-9]{32}' | head -1)
fi
if [[ -z "$TOK" ]]; then
  echo "  (shared token not present in box yet — bootstrapping via token.sh get,"
  echo "   which REUSES the shared token, never mints per-agent)"
  TOK=$(/tmp/r.sh "cd /workspace && bash token.sh get" 2>&1 | grep -oE '[A-Za-z0-9]{32}' | head -1)
fi
if [[ "${#TOK}" -eq 32 ]]; then
  umask 077
  printf '%s\n' "$TOK" > "$HOME/.r2_token"
  chmod 600 "$HOME/.r2_token"
  echo "  shared 24h token delivered -> $HOME/.r2_token (chmod 600)"
  echo "  r2.sh auto-reads ~/.r2_token — no R2_SSH_TOKEN export needed."
else
  echo "  FAIL: could not fetch the shared WSS token from the box."
fi
WSS_OUT=$(/tmp/r2.sh "echo WSS_OK-$MARKER" 2>&1)
if echo "$WSS_OUT" | grep -q "WSS_OK"; then
  echo "  $WSS_OUT"
  echo "  WSS OK ✓ — r2.sh streaming exec works end-to-end."
elif echo "$WSS_OUT" | grep -qiE "404|not served|daemon|401|403|upgrade"; then
  echo "  $WSS_OUT" | head -2
  echo "  ⚠ WSS round-trip FAILED — this is a REAL failure (the WSS endpoint"
  echo "    accepts the API key as Authorization: Bearer; r2.sh does this now)."
  echo "    Check the API key / proxy reachability — do NOT treat it as a"
  echo "    'known upgrade issue'; report it."
else
  echo "  $WSS_OUT" | head -2
  echo "  ⚠ WSS round-trip failed — see output above (token file: $HOME/.r2_token)."
fi

echo ""
echo "── [H] MCP tool surface (r.sh --tools + exec round-trip) ──"
MCP_TOOLS=$(/tmp/r.sh --tools 2>&1)
if echo "$MCP_TOOLS" | grep -q "MCP tools available"; then
  echo "  $MCP_TOOLS"
  echo "  MCP OK ✓ — tool list served via /toolbox/<SID>/mcp (JSON-RPC, no REST fallback)."
else
  echo "  $MCP_TOOLS" | head -3
  echo "  ⚠ /mcp not served yet (expected until the sandbox daemon upgrade lands)."
  echo "    r.sh exec falls back to REST /process/execute; file ops fall back to /files."
fi
MCP_RT=$(/tmp/r.sh "echo MCP_OK-$MARKER" 2>&1)
if echo "$MCP_RT" | grep -q "MCP_OK"; then
  echo "  exec round-trip: $MCP_RT"
else
  echo "  exec round-trip (REST fallback active): $(echo "$MCP_RT" | head -1)"
fi

echo ""
echo "── CLEANUP ──"
curl -s -X DELETE "$BASE/files?path=/workspace/warmup_marker.txt" -A "$UA" -H "Authorization: Bearer $API_KEY" > /dev/null 2>&1
rm -f /tmp/warmup_marker.txt
echo "  done"

echo ""
echo "=============================================="
echo " RESULT: paste this FULL output in your first message."
echo " The hostname in [B] MUST be the DAYTONA sandbox container,"
echo " not your local machine. If it is local — you are in the"
echo " WRONG environment; stop and reconnect via the API."
echo " [E] confirms: commit/push happens in DAYTONA only."
echo " [F] confirms: GitHub issue access works from DAYTONA."
echo " [G] delivers the shared WSS token to ~/.r2_token (r2.sh works)."
echo " [H] confirms: the MCP tool surface (exec/read/write/list via /mcp)."
echo "=============================================="
