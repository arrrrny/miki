#!/usr/bin/env bash
# ==============================================================
# r.sh — Remote shell executor for Zuzu sandbox via MCP
# Usage:
#   r.sh <command>                 Run command, print stdout+stderr
#   r.sh -d <dir> <command>        Run command in <dir> (cwd)
#   r.sh -t <secs> <command>       Run command with timeout (default 120)
#   r.sh -s <file>                 Read remote file (MCP fs_read_file; falls
#                                  back to REST /files/download when /mcp is
#                                  not provisioned)
#   r.sh -w <file> <content>       Write remote file (MCP fs_write_file; falls
#                                  back to REST /files/upload when /mcp is not
#                                  provisioned)
#   r.sh -l <dir>                  List remote directory (MCP fs_list_files;
#                                  falls back to REST /files)
#   r.sh --tools                   List all MCP tools + their args
#   r.sh --check                   Health check
#   r.sh --ship [--dry-run] <repo-dir> <branch> "title" [issue] [body]
#                                  ONE-COMMAND commit+push+PR (inside sandbox)
#   r.sh --claim <taskId> [--model <model>]
#                                  Claim a pool task (default model: kimi)
#   r.sh --complete <taskId> <prUrl|.patch|.tar.gz|message>
#                                  Complete a pool task with a result
#   r.sh --update <taskId> <message>
#                                  Append a status update to the task feed
#   r.sh --pool-status              Show the local pool replica status
#   These hit the pool at localhost:9999 where r.sh runs — the sandbox
#   replica in the box (auto-bootstrapped via /workspace/pool.sh --ensure)
#   or the authoritative MBP pool when run from the MBP. The MBP bridge
#   mirrors box-side results back into the authoritative pool.
# Exit: 0=ok, 1=remote fail, 2=net/auth error, 3=pool API error, 254=CF block
# ==============================================================
set -euo pipefail

# Pool identity — single source of truth: run/.pool_env (or env override).
# Fallbacks are the historical baked values (only used if .pool_env is absent).
if [ -z "${POOL_SID:-}" ] || [ -z "${POOL_API_KEY:-}" ]; then
  _sb="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." 2>/dev/null && pwd)"
  _pe="$_sb/run/.pool_env"
  [ -f "$_pe" ] && source "$_pe"
  if [ -z "${POOL_SID:-}" ] && [ -f "run/.pool_env" ]; then source "run/.pool_env"; fi
fi
SID="${POOL_SID:-0d413bc6-cfab-40d8-80fc-0658af42c0b9}"
AK="${POOL_API_KEY:-dtn_5f9c41aa161abf22e2d86368eda4a9b50eca699a3de8f367b834e77ba2531beb}"
URL="https://proxy.zuzu.dev/toolbox/${SID}/mcp"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.0"

# ==============================================================
# Per-session command logging (agent analytics) — best-effort, NEVER affects
# the command. Appends one JSONL line per invocation to
# /workspace/.agent-logs/commands.jsonl inside the sandbox via REST exec.
# Session id persists in ~/.daytona_session; start a fresh session per
# delegation with: rm -f ~/.daytona_session
# ==============================================================
LOG_REST="https://proxy.zuzu.dev/toolbox/${SID}/process/execute"
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
    -A "$UA" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" \
    -d "{\"command\":\"mkdir -p $LOG_DIR && (echo $b64 | base64 -d; echo) >> $LOG_FILE\"}" >/dev/null 2>&1 || true
}

die() { echo "r.sh: $*" >&2; exit 255; }

cf_check() {
  [[ "$1" == "<!doctype html"* || "$1" == "<!DOCTYPE html"* || "$1" == "<html"* ]] \
    && { echo "r.sh: Cloudflare block detected" >&2; exit 254; } || true
}

auth_check() {
  if echo "$1" | grep -q '^data: {'; then
    if echo "$1" | python3 -c '
import json, sys, re
raw = sys.stdin.read()
m = re.search(r"^data: (\{.*\})$", raw, re.M)
if m:
    obj = json.loads(m.group(1))
    if "error" in obj:
        sys.exit(0)
    sys.exit(1)
' 2>/dev/null; then
      echo "r.sh: Auth failed (401). Key expired." >&2
      exit 2
    fi
  fi
  return 0
}

parse_sse() {
  local raw="$1"
  cf_check "$raw"
  auth_check "$raw"
  local data_line
  data_line=$(echo "$raw" | grep -E '^data: \{' | head -1 | sed 's/^data: //')
  [[ -z "$data_line" ]] && { echo "r.sh: MCP endpoint not responding (no SSE data frame — /mcp likely not deployed on the sandbox daemon; exec/file ops fall back to REST)" >&2; exit 2; }
  echo "$data_line"
}

extract_output() {
  python3 -c '
import json, sys
try:
    obj = json.loads(sys.stdin.read())
    content = obj.get("result", {}).get("content", [])
    if not content:
        print("r.sh: empty content", file=sys.stderr)
        sys.exit(2)
    text = content[0].get("text", "")
    lines = text.rstrip("\n").split("\n")
    if lines and lines[-1].startswith("exitCode:"):
        code = int(lines[-1].split(":")[1].strip())
        lines = lines[:-1]
    else:
        code = 0
    output = "\n".join(lines)
    if output:
        print(output)
    sys.exit(code if code != 0 else 0)
except Exception as e:
    print(f"r.sh: {e}", file=sys.stderr)
    sys.exit(2)
' <<< "$1"
}

mcp_exec() {
  local cmd="$1" cwd="$2" timeout="$3"
  # Auto-load PATH/dart/flutter/GITHUB_TOKEN for the non-interactive MCP shell
  # and ensure /workspace tools (sgh, gitpatch, ship.sh, upload.sh) are on PATH
  cmd="export DAYTONA_SESSION='$(session_id)'; source ~/.bash_env 2>/dev/null; export PATH=/workspace:\$PATH; $cmd"
  local args_json
  if [[ -n "$cwd" ]]; then
    args_json=$(python3 -c 'import json,sys; c=sys.argv[1]; d=sys.argv[2]; t=int(sys.argv[3]); print(json.dumps({"command":c,"cwd":d,"timeout":t}))' "$cmd" "$cwd" "$timeout")
  else
    args_json=$(python3 -c 'import json,sys; c=sys.argv[1]; t=int(sys.argv[2]); print(json.dumps({"command":c,"timeout":t}))' "$cmd" "$timeout")
  fi
  local response
  response=$(curl -s --max-time $((timeout + 15)) -X POST "$URL" \
    -A "$UA" \
    -H "Authorization: Bearer $AK" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"exec_command\",\"arguments\":$args_json}}")
  local data
  # If MCP isn't provisioned for this sandbox (404 — c562a660), fall back to
  # the REST /process/execute transport, which the proxy does expose.
  if ! echo "$response" | grep -q 'data: {'; then
    local REST_URL="https://proxy.zuzu.dev/toolbox/${SID}/process/execute"
    local rest
    rest=$(curl -s --max-time $((timeout + 15)) -X POST "$REST_URL" \
      -A "$UA" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" \
      -d "$args_json")
    echo "$rest" | python3 -c 'import json,sys
try:
    d=json.loads(sys.stdin.read())
    print(d.get("result") or "", end="")
    sys.exit(int(d.get("exitCode") or 0))
except Exception as e:
    print("r.sh: REST err:", e, file=sys.stderr); sys.exit(2)'
    return
  fi
  data=$(parse_sse "$response")
  extract_output "$data"
}

# URL-encode a path for the REST /files query string.
rest_qpath() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

# REST fallbacks for the file ops: when the MCP endpoint is not provisioned
# (the /mcp route is served by the sandbox daemon, which needs the
# SSH-over-HTTPS upgrade — see AGENTS.md), -s/-w/-l fall back to the /files
# REST API just like exec falls back to /process/execute. The fallback is
# silent on stdout (same output shape) and logs one line to stderr.

mcp_read() {
  local filepath="$1"
  local response
  response=$(curl -s --max-time 30 -X POST "$URL" \
    -A "$UA" \
    -H "Authorization: Bearer $AK" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"fs_read_file\",\"arguments\":{\"path\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$filepath")}}}")
  if ! echo "$response" | grep -q 'data: {'; then
    echo "r.sh: MCP read unavailable, using REST /files/download fallback" >&2
    curl -s --max-time 30 "https://proxy.zuzu.dev/toolbox/${SID}/files/download?path=$(rest_qpath "$filepath")" \
      -A "$UA" -H "Authorization: Bearer $AK"
    return
  fi
  local data
  data=$(parse_sse "$response")
  python3 -c '
import json, sys
obj = json.loads(sys.stdin.read())
content = obj.get("result", {}).get("content", [])
if content:
    print(content[0].get("text", ""), end="")
else:
    sys.exit(2)
' <<< "$data"
}

mcp_write() {
  local filepath="$1"
  local content="$2"
  local response
  response=$(curl -s --max-time 30 -X POST "$URL" \
    -A "$UA" \
    -H "Authorization: Bearer $AK" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"fs_write_file\",\"arguments\":{\"path\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$filepath"),\"content\":$(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' <<< "$content")}}}")
  if ! echo "$response" | grep -q 'data: {'; then
    echo "r.sh: MCP write unavailable, using REST /files/upload fallback" >&2
    local tmp http
    tmp=$(mktemp /tmp/rsh_write.XXXXXX)
    printf '%s' "$content" > "$tmp"
    http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST \
      "https://proxy.zuzu.dev/toolbox/${SID}/files/upload?path=$(rest_qpath "$filepath")" \
      -A "$UA" -H "Authorization: Bearer $AK" -F "file=@$tmp")
    rm -f "$tmp"
    if [[ "$http" == "2"* ]]; then
      echo "Written to $filepath"
      return
    fi
    echo "r.sh: write failed — MCP down + REST /files/upload HTTP $http" >&2
    exit 2
  fi
  local data
  data=$(parse_sse "$response")
  echo "Written to $filepath"
}

mcp_list() {
  local dirpath="$1"
  local response
  response=$(curl -s --max-time 30 -X POST "$URL" \
    -A "$UA" \
    -H "Authorization: Bearer $AK" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"fs_list_files\",\"arguments\":{\"path\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$dirpath")}}}")
  if ! echo "$response" | grep -q 'data: {'; then
    echo "r.sh: MCP list unavailable, using REST /files fallback" >&2
    curl -s --max-time 30 "https://proxy.zuzu.dev/toolbox/${SID}/files?path=$(rest_qpath "$dirpath")" \
      -A "$UA" -H "Authorization: Bearer $AK" | python3 -c '
import json, sys
try:
    items = json.load(sys.stdin)
    for f in items:
        kind = "d" if f.get("isDir") else "-"
        sz = f.get("size", 0)
        mt = (f.get("modifiedAt") or "")[:19]
        print(kind + " " + str(sz).rjust(12) + " " + mt + " " + f.get("name", ""))
except Exception as e:
    print("r.sh: list fallback failed: " + str(e), file=sys.stderr)
    sys.exit(2)
'
    return
  fi
  local data
  data=$(parse_sse "$response")
  python3 -c '
import json, sys
obj = json.loads(sys.stdin.read())
content = obj.get("result", {}).get("content", [])
if content:
    print(content[0].get("text", ""))
' <<< "$data"
}

if [[ $# -eq 0 ]]; then
  die "Usage: r.sh <cmd> | r.sh -s <file> | r.sh -w <file> <content> | r.sh -l <dir> | r.sh --check"
fi

# ==============================================================
# Pool task API helpers — r.sh --claim / --complete / --update.
# The pool is localhost:9999 WHEREVER r.sh runs: the sandbox replica inside
# the box (pool.sh bootstraps it on demand) or the authoritative MBP pool.
# In the box, ensure the replica is up before touching it (fast no-op when
# already up; first-ever ensure clones the repo + starts the replica).
# ==============================================================
pool_ensure() {
  if [ -f /workspace/pool.sh ]; then
    bash /workspace/pool.sh --ensure >/dev/null 2>&1 || true
  fi
}

json_obj() { # $1=key $2=value -> JSON object (value JSON-escaped)
  python3 -c 'import json,sys; print(json.dumps({sys.argv[1]: sys.argv[2]}))' "$1" "$2"
}

pool_call() { # $1=method $2=path $3=json-body
  local method="$1" path="$2" body="$3" out code
  out=$(curl -s -m 30 -X "$method" "http://localhost:9999$path" \
    -H 'Content-Type: application/json' -d "$body")
  code=$?
  echo "$out"
  if [ $code -ne 0 ]; then
    echo "r.sh: pool unreachable (curl exit $code) — is the pool up? bash /workspace/pool.sh --status" >&2
    return 2
  fi
  # A JSON {"error": ...} response means the pool API rejected the call (3).
  echo "$out" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    sys.exit(3 if isinstance(d, dict) and d.get("error") else 0)
except Exception:
    sys.exit(0)' || return 3
}

# ==============================================================
# herdr pane integration — BEST-EFFORT status reflection into the
# box herdr. Cloud agents report activity via # -prefixed marker
# lines (shell comments — never executed) in a per-task herdr tab.
# The bridge reads the box herdr snapshot as the single status
# source of truth for cloud tasks. All herdr calls are best-effort:
# they NEVER block or fail the pool operation. A heartbeat file
# fallback (/workspace/.herdr/<taskId>.status mtime) covers the
# case where herdr's built-in agent detection classifies the Z.ai
# cloaked agent as "unknown".
# ==============================================================
HERDR_SOCK="${HERDR_SOCK:-/home/daytona/.config/herdr/herdr.sock}"
HERDR_PANE_DIR="/workspace/.herdr_panes"
HERDR_HB_DIR="/workspace/.herdr"

_herdr_api() {
  local method="$1" params="${2:-\{\}}"
  python3 -c "
import json, socket, sys
try:
    s = socket.socket(socket.AF_UNIX)
    s.connect('$HERDR_SOCK')
    s.sendall((json.dumps({'id':'r','method':sys.argv[1],'params':json.loads(sys.argv[2])})+chr(10)).encode())
    buf=b''; s.settimeout(3)
    try:
        while True:
            d=s.recv(65536)
            if not d: break
            buf+=d
    except: pass
    s.close()
    sys.stdout.write(buf.decode(errors='replace'))
except Exception:
    sys.exit(1)
" "$method" "$params" 2>/dev/null
}

_herdr_ensure_server() {
  _herdr_api session.snapshot '{}' 2>/dev/null | \
    python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null && return 0
  setsid nohup herdr server >/tmp/herdr-server.log 2>&1 < /dev/null & disown
  sleep 2
  _herdr_api session.snapshot '{}' 2>/dev/null | \
    python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null
}

_herdr_workspace_id() {
  _herdr_api session.snapshot '{}' 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for w in d.get('result',{}).get('workspaces',[]):
    if '/workspace' in (w.get('cwd') or ''):
        print(w.get('workspace_id','')); sys.exit(0)
ws=d.get('result',{}).get('workspaces',[])
if ws: print(ws[0].get('workspace_id',''))
" 2>/dev/null
}

_herdr_ensure_pane() {
  local task_id="$1"
  local pane_file="$HERDR_PANE_DIR/$task_id"
  # Use cached pane if available
  if [[ -f "$pane_file" ]]; then
    cat "$pane_file" 2>/dev/null
    return 0
  fi
  _herdr_ensure_server 2>/dev/null || return 0
  local ws pane_id cwd
  ws=$(_herdr_workspace_id 2>/dev/null)
  [[ -z "$ws" ]] && return 0
  # WORKTREE MODE (2026-08-16): when the brief set WORKTREE=<path>, the task's
  # herdr pane opens in the agent's own git worktree — not the shared
  # /workspace checkout (parallel same-repo agents must not share it).
  cwd="${WORKTREE:-/workspace}"
  pane_id=$(_herdr_api tab.create \
    "{\"workspace_id\":\"$ws\",\"label\":\"$task_id\",\"cwd\":\"$cwd\"}" 2>/dev/null | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('root_pane',{}).get('pane_id',''))" 2>/dev/null)
  if [[ -n "$pane_id" ]]; then
    mkdir -p "$HERDR_PANE_DIR" 2>/dev/null
    echo "$pane_id" > "$pane_file" 2>/dev/null
    echo "$pane_id"
  fi
}

_herdr_write_marker() {
  local task_id="$1" marker="$2"
  local pane_id
  pane_id=$(_herdr_ensure_pane "$task_id" 2>/dev/null)
  [[ -z "$pane_id" ]] && return 0
  python3 -c "
import json, socket, sys
try:
    s=socket.socket(socket.AF_UNIX); s.connect('$HERDR_SOCK')
    payload={'id':'r','method':'pane.send_input','params':{'pane_id':sys.argv[1],'text':'# '+sys.argv[2]+chr(10)}}
    s.sendall((json.dumps(payload)+chr(10)).encode())
    s.settimeout(2)
    try:
        while True:
            if not s.recv(65536): break
    except: pass
    s.close()
except Exception:
    pass
" "$pane_id" "$marker" 2>/dev/null || true
}

_herdr_heartbeat() {
  local task_id="$1"
  mkdir -p "$HERDR_HB_DIR" 2>/dev/null
  date +%s > "$HERDR_HB_DIR/$task_id.status" 2>/dev/null || true
}

LOG_CMD="$*"; LOG_CMD="${LOG_CMD:0:500}"
LOG_OP="${1:-none}"
LOG_START=$(now_ms)
trap 'log_call "${0##*/}" "${LOG_CMD:-}" "$?" "$(($(now_ms)-LOG_START))" "${LOG_OP:-}"' EXIT

case "$1" in
  --check)
    echo -n "MCP: "
    resp=$(curl -s --max-time 10 -X POST "$URL" \
      -A "$UA" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":0,"method":"tools/list"}')
    cf_check "$resp"
    auth_check "$resp"
    echo "$resp" | grep -q '"tools"' && echo "OK" || { echo "FAIL"; exit 2; }
    ;;
  --tools)
    resp=$(curl -s --max-time 10 -X POST "$URL" \
      -A "$UA" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":0,"method":"tools/list"}')
    cf_check "$resp"
    auth_check "$resp"
    data=$(parse_sse "$resp")
    python3 -c '
import json, sys
obj = json.loads(sys.stdin.read())
tools = obj.get("result", {}).get("tools", [])
print(str(len(tools)) + " MCP tools available:")
for t in tools:
    props = t.get("inputSchema", {}).get("properties", {})
    req = t.get("inputSchema", {}).get("required", [])
    parts = []
    for k in props:
        marker = "*" if k in req else ""
        parts.append(k + marker)
    print("  " + t["name"] + "(" + ", ".join(parts) + ")")
    print("      " + t.get("description", "")[:100])
' <<< "$data"
    ;;
  -d)
    [[ $# -lt 3 ]] && die "-d requires <dir> <command>"
    mcp_exec "${*:3}" "$2" "120"
    ;;
  -t)
    [[ $# -lt 3 ]] && die "-t requires <secs> <command>"
    mcp_exec "${*:3}" "" "$2"
    ;;
  -s)
    [[ $# -lt 2 ]] && die "-s requires file path"
    mcp_read "$2"
    ;;
  -w)
    [[ $# -lt 3 ]] && die "-w requires <file> <content>"
    mcp_write "$2" "$3"
    ;;
  -l)
    [[ $# -lt 2 ]] && die "-l requires dir path"
    mcp_list "$2"
    ;;
  --ship)
    # ONE command: git add/commit/push + gh pr create, run inside the sandbox
    # r.sh --ship [--dry-run] <repo-dir> <branch> "title" [issue] [body]
    [[ $# -lt 4 ]] && die "--ship requires [--dry-run] <repo-dir> <branch> \"title\" [issue] [body]"
    shift  # drop --ship
    remote_cmd=$(python3 -c '
import shlex, sys
args = sys.argv[1:]
print("bash /workspace/ship.sh " + " ".join(shlex.quote(a) for a in args))
' "$@")
    mcp_exec "$remote_cmd" "" "300"
    ;;
  -h|--help)
    sed -n '3,12p' "$0" | sed 's/^# //' | sed 's/^#//'
    ;;
  --cr-review)
    # CodeRabbit-replacement: run the review decision chain on the PR with
    # the zikzak-ai identity (inside the sandbox via cr_review.sh).
    # r.sh --cr-review <owner/repo> <pull>
    [[ $# -lt 3 ]] && die "--cr-review requires <owner/repo> <pull>"
    mcp_exec "bash /workspace/cr_review.sh $2 $3" "" "180"
    ;;
  --cr-apply)
    # Apply the CodeRabbit autofix as zikzak-ai (inside the sandbox).
    # r.sh --cr-apply <owner/repo> <pull>
    [[ $# -lt 3 ]] && die "--cr-apply requires <owner/repo> <pull>"
    mcp_exec "bash /workspace/cr_apply.sh $2 $3" "" "180"
    ;;
  --claim)
    # r.sh --claim <taskId> [--model <model>] — claim a pending pool task.
    # Also creates a herdr pane for the task + writes a heartbeat file +
    # a `# claim` marker so the bridge can see live activity from the box.
    # WORKTREE MODE: when WORKTREE=<path> is set (the launch brief carries it),
    # the pane opens in the agent's own git worktree — work ONLY there, never
    # the shared /workspace checkout.
    [[ $# -lt 2 ]] && die "--claim requires <taskId>"
    pool_ensure
    model="${3:-kimi}"
    pool_call POST "/tasks/$2/claim" "$(json_obj model "$model")"
    _herdr_heartbeat "$2" || true
    _herdr_write_marker "$2" "claim $2 $(date -u +%H:%M:%S)" || true
    if [ -n "${WORKTREE:-}" ]; then
      echo "r.sh: worktree $WORKTREE (work ONLY there; never /workspace shared checkout)" >&2
    fi
    ;;
  --complete)
    # r.sh --complete <taskId> <prUrl|.patch|.tar.gz|message> — record the
    # agent's result: http(s) URL -> prUrl, *.patch -> patchPath, *.tar* ->
    # tarballPath, anything else -> errorMessage (failed task report).
    # Also writes a `# done` marker into the task's herdr pane as completion
    # evidence for the bridge.
    [[ $# -lt 3 ]] && die "--complete requires <taskId> <prUrl|artifact>"
    pool_ensure
    val="$3"
    if [[ "$val" == http* ]]; then payload=$(json_obj prUrl "$val")
    elif [[ "$val" == *.patch ]]; then payload=$(json_obj patchPath "$val")
    elif [[ "$val" == *.tar* ]]; then payload=$(json_obj tarballPath "$val")
    else payload=$(json_obj errorMessage "$val"); fi
    pool_call POST "/tasks/$2/complete" "$payload"
    _herdr_write_marker "$2" "done $2 $val" || true
    ;;
  --update)
    # r.sh --update <taskId> <message> — append a status update (the agent's
    # update also doubles as its heartbeat on the pool). Also writes a
    # heartbeat file + a `# update` marker into the task's herdr pane.
    [[ $# -lt 3 ]] && die "--update requires <taskId> <message>"
    pool_ensure
    pool_call POST "/tasks/$2/update" "$(json_obj message "$3")"
    _herdr_heartbeat "$2" || true
    _herdr_write_marker "$2" "update $2 $(date -u +%H:%M:%S)" || true
    ;;
  --pool-status)
    if [ -f /workspace/pool.sh ]; then
      bash /workspace/pool.sh --status
    else
      curl -s -m 5 http://localhost:9999/health || echo "pool: DOWN"
    fi
    ;;
  *)
    mcp_exec "$*" "" "120"
    ;;
esac
