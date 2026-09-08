#!/usr/bin/env bash
# ==============================================================
# r2.sh — Full SSH experience over WebSocket (WSS) + REST file ops
# For ZikZak Daytona sandbox
#
# Usage:
#   r2.sh <command>                Run command (streaming, ssh-like)
#   r2.sh -i                       Interactive PTY shell (like ssh host)
#   r2.sh -d <dir> <command>       Run command in <dir> (cwd)
#   r2.sh -e KEY=VALUE <command>   Run command with env var
#   r2.sh -t <secs> <command>      Run command with server timeout
#   r2.sh -k <signal> <command>    Send signal to running process (SIGINT/SIGTERM)
#   r2.sh -l <dir>                 List remote directory (REST)
#   r2.sh -s <file> [local-dest]    Download remote file (REST, binary-safe).
#                                  With [local-dest]: saves to that file.
#                                  Without: prints to stdout.
#   r2.sh -w <file> <local-path>   Upload local file (REST, large files OK)
#   r2.sh -delf <file>             Delete remote file (REST)
#   r2.sh --check                  Verify connectivity (REST, API key)
#   r2.sh --ship [--dry-run] <repo-dir> <branch> "title" [issue] [body]
#                                  ONE-COMMAND commit+push+PR (inside sandbox)
#   r2.sh --claim <taskId> [--model <m>]     Claim a pool task (inside box)
#   r2.sh --complete <taskId> <prUrl|.patch|.tar.gz|msg>   Complete a pool task
#   r2.sh --update <taskId> <message>        Append a status update
#   r2.sh --pool-status                      Local pool replica status
#   (these delegate to /workspace/r.sh inside the box — the box's pool replica
#   is auto-bootstrapped by /workspace/pool.sh --ensure)
#   r2.sh --help                   Show this help
#
# Auth: WSS uses SSH token (24h); REST file ops use non-expiring API key.
# Exit: 0=ok, 1=remote fail, 2=auth/network, 254=Cloudflare, 255=usage
# ==============================================================
set -euo pipefail

# Pool identity — single source of truth: run/.pool_env (or env override).
if [ -z "${POOL_SID:-}" ] || [ -z "${POOL_API_KEY:-}" ]; then
  _sb="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." 2>/dev/null && pwd)"
  _pe="$_sb/run/.pool_env"
  [ -f "$_pe" ] && source "$_pe"
  if [ -z "${POOL_SID:-}" ] && [ -f "run/.pool_env" ]; then source "run/.pool_env"; fi
fi
SID="${POOL_SID:-3c0d7459-2b26-4630-a381-9b7134b6417b}"
AK="${POOL_API_KEY:-dtn_a89240b5311ca475455011491cca38d3f778ed7e8ff014f122f4d2d9bd00127d}"          # non-expiring
SSH_TOKEN="${R2_SSH_TOKEN:-}"                                                          # 24h WSS token (set via env or edit below)
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.0"
WSS_BASE="wss://proxy.zuzu.dev/toolbox/${SID}/process/exec/connect"
REST_BASE="https://proxy.zuzu.dev/toolbox/${SID}"

# ==============================================================
# Per-session command logging (agent analytics) — best-effort, NEVER affects
# the command. Appends one JSONL line per invocation to
# /workspace/.agent-logs/commands.jsonl inside the sandbox via REST exec.
# Session id persists in ~/.daytona_session; start a fresh session per
# delegation with: rm -f ~/.daytona_session
# ==============================================================
LOG_REST="${REST_BASE}/process/execute"
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

die() { echo "r2.sh: $*" >&2; exit 255; }

# ---------- WSS exec (SSH token) ----------
wss_exec() {
  local start_json="$1"
  local sig_frame="${2:-}"
  export DAYTONA_SESSION="$(session_id)"
  # WSS auth: the proxy accepts the API KEY as `Authorization: Bearer <key>`
  # (verified 2026-08-15 — the old `?token=<R2 token>` form 401s). The R2
  # token is a legacy SSH-gateway credential; the WSS endpoint wants the
  # dtn_ API key. Pass it via env so the python below can build the header.
  export R2_WSS_BEARER="$AK"
  python3 - "$WSS_BASE" "$start_json" "$sig_frame" "$UA" "$AK" <<'PYEOF'
import asyncio, json, sys, websockets

async def main():
    base, start_json, sig, ua, api_key = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
    start = json.loads(start_json)
    token = start.pop("__token", "")
    if not token:
        token = __import__("os").environ.get("R2_SSH_TOKEN", "")
    uri = f"{base}"
    try:
        # Auto-load PATH/dart/flutter/GITHUB_TOKEN for the non-interactive WSS shell
        # and ensure /workspace tools (sgh, gitpatch, ship.sh, upload.sh) are on PATH
        if "command" in start:
            start["command"] = "export DAYTONA_SESSION='" + __import__("os").environ.get("DAYTONA_SESSION", "") + "'; source ~/.bash_env 2>/dev/null; export PATH=/workspace:$PATH; " + start["command"]
        # Auth via the API key header (the endpoint rejects query-token auth).
        headers = {"User-Agent": ua, "Authorization": f"Bearer {api_key}"}
        async with websockets.connect(uri, max_size=100*1024*1024, ping_interval=None, ping_timeout=None, additional_headers=headers) as ws:
            await ws.send(json.dumps(start))
            if sig:
                await asyncio.sleep(1)
                await ws.send(json.dumps({"type": "signal", "signal": sig}))
            while True:
                msg = await ws.recv()
                frame = json.loads(msg)
                t = frame.get("type")
                if t == "stdout":
                    sys.stdout.write(frame.get("data", ""))
                    sys.stdout.flush()
                elif t == "stderr":
                    sys.stderr.write(frame.get("data", ""))
                    sys.stderr.flush()
                elif t == "exit":
                    sys.exit(frame.get("exitCode", 0))
                elif t == "error":
                    print(f"\nr2.sh: remote error: {frame.get('message')}", file=sys.stderr)
                    sys.exit(2)
    except Exception as e:
        msg = str(e)
        hint = ""
        if "404" in msg:
            hint = " (the sandbox daemon does not serve /process/exec/connect yet — needs the SSH-over-HTTPS daemon upgrade, see AGENTS.md)"
        elif "401" in msg or "403" in msg:
            hint = " (token rejected here — if warmup [G] delivered a fresh shared token and it still 401s, the proxy/daemon predates the SSH-over-HTTPS upgrade; see AGENTS.md)"
        print(f"r2.sh: connection error: {msg}{hint}", file=sys.stderr)
        sys.exit(2)

asyncio.run(main())
PYEOF
}

# ---------- Interactive PTY shell ----------
wss_interactive() {
  python3 - "$WSS_BASE" "$UA" "$AK" <<'PYEOF'
import asyncio, json, os, sys, websockets, shutil

async def main():
    base, ua, api_key = sys.argv[1], sys.argv[2], sys.argv[3]
    token = os.environ.get("R2_SSH_TOKEN", "")
    uri = f"{base}"
    cols, rows = shutil.get_terminal_size((80, 24))
    try:
        headers = {"User-Agent": ua, "Authorization": f"Bearer {api_key}"}
        async with websockets.connect(uri, max_size=100*1024*1024, ping_interval=None, ping_timeout=None, additional_headers=headers) as ws:
            await ws.send(json.dumps({"type": "start", "cols": cols, "rows": rows}))
            # reader: send stdin -> server
            async def reader():
                loop = asyncio.get_running_loop()
                while True:
                    line = await loop.run_in_executor(None, sys.stdin.readline)
                    if not line:
                        await ws.send(json.dumps({"type": "stdin_eof"}))
                        break
                    await ws.send(json.dumps({"type": "stdin", "data": line}))
            # writer: server frames -> stdout
            async def writer():
                while True:
                    msg = await ws.recv()
                    frame = json.loads(msg)
                    t = frame.get("type")
                    if t == "stdout":
                        sys.stdout.write(frame.get("data", ""))
                        sys.stdout.flush()
                    elif t == "stderr":
                        sys.stderr.write(frame.get("data", ""))
                        sys.stderr.flush()
                    elif t == "exit":
                        os._exit(frame.get("exitCode", 0))
                    elif t == "error":
                        print(f"\nr2.sh: {frame.get('message')}", file=sys.stderr)
                        os._exit(2)
            await asyncio.gather(reader(), writer())
    except Exception as e:
        print(f"r2.sh: {e}", file=sys.stderr)
        sys.exit(2)

asyncio.run(main())
PYEOF
}

# ---------- REST helpers (API key) ----------
rest_get() { # $1=path $2=query
  curl -s -A "$UA" -H "Authorization: Bearer $AK" "${REST_BASE}${1}?${2}"
}

rest_list() {
  rest_get "/files" "path=$1" | python3 -c '
import json, sys
size = lambda n: str(n)
try:
    items = json.load(sys.stdin)
    for f in items:
        kind = "d" if f.get("isDir") else "-"
        sz = f.get("size", 0)
        mt = (f.get("modifiedAt", "") or "")[:19]
        nm = f.get("name", "")
        print(kind + " " + str(sz).rjust(12) + " " + mt + " " + nm)
except Exception as e:
    print("r2.sh: " + str(e), file=sys.stderr)
    sys.exit(2)
'
}

rest_download() {
  curl -s -A "$UA" -H "Authorization: Bearer $AK" "${REST_BASE}/files/download?path=$1"
}

rest_upload() { # $1=remote path $2=local file
  curl -s -X POST -A "$UA" -H "Authorization: Bearer $AK" \
    -F "file=@$2" "${REST_BASE}/files/upload?path=$1"
}

rest_delete() {
  curl -s -X DELETE -A "$UA" -H "Authorization: Bearer $AK" "${REST_BASE}/files?path=$1"
}

# ---------- Main ----------
if [[ $# -eq 0 ]]; then
  sed -n '4,20p' "$0" | sed 's/^# //' | sed 's/^#//'
  die "no command given"
fi

# If SSH token not set in env, try reading from ~/.r2_token
if [[ -z "$SSH_TOKEN" && -f ~/.r2_token ]]; then
  SSH_TOKEN="$(cat ~/.r2_token)"
fi
if [[ -z "$SSH_TOKEN" ]]; then
  echo "r2.sh: R2_SSH_TOKEN not set and ~/.r2_token missing. Warmup.sh [G]" >&2
  echo "        delivers the SHARED token to ~/.r2_token automatically; run it first," >&2
  echo "        or export R2_SSH_TOKEN=<24h-token> (shared token, never mint per-agent)." >&2
  exit 2
fi
export R2_SSH_TOKEN="$SSH_TOKEN"

LOG_CMD="$*"; LOG_CMD="${LOG_CMD:0:500}"
LOG_OP="${1:-none}"
LOG_START=$(now_ms)
trap 'log_call "${0##*/}" "${LOG_CMD:-}" "$?" "$(($(now_ms)-LOG_START))" "${LOG_OP:-}"' EXIT

case "$1" in
  --check)
    # REST check with API key (works without SSH token)
    resp=$(curl -s -A "$UA" -H "Authorization: Bearer $AK" "${REST_BASE}/files?path=/workspace" 2>&1)
    if echo "$resp" | grep -q '\[{'; then echo "REST: OK"; else echo "REST: FAIL — $resp" | head -c 120; echo; fi
    ;;
  -i)
    wss_interactive
    ;;
  -d)
    [[ $# -lt 3 ]] && die "-d requires <dir> <command>"
    local_cmd="${*:3}"
    wss_exec "$(python3 -c 'import json,sys; print(json.dumps({"type":"start","command":sys.argv[1],"cwd":sys.argv[2],"__token":sys.argv[3]}))' "$local_cmd" "$2" "$SSH_TOKEN")"
    ;;
  -e)
    [[ $# -lt 3 ]] && die "-e requires KEY=VALUE <command>"
    envpair="$2"
    local_cmd="${*:3}"
    wss_exec "$(python3 -c 'import json,sys; print(json.dumps({"type":"start","command":sys.argv[1],"env":{sys.argv[2].split("=")[0]:sys.argv[2].split("=",1)[1]},"__token":sys.argv[3]}))' "$local_cmd" "$envpair" "$SSH_TOKEN")"
    ;;
  -t)
    [[ $# -lt 3 ]] && die "-t requires <secs> <command>"
    local_cmd="${*:3}"
    wss_exec "$(python3 -c 'import json,sys; print(json.dumps({"type":"start","command":sys.argv[1],"timeout":int(sys.argv[2]),"__token":sys.argv[3]}))' "$local_cmd" "$2" "$SSH_TOKEN")"
    ;;
  -k)
    [[ $# -lt 3 ]] && die "-k requires <signal> <command>"
    sig="$2"
    local_cmd="${*:3}"
    wss_exec "$(python3 -c 'import json,sys; print(json.dumps({"type":"start","command":sys.argv[1],"__token":sys.argv[2]}))' "$local_cmd" "$SSH_TOKEN")" "$sig"
    ;;
  -l)
    [[ $# -lt 2 ]] && die "-l requires dir path"
    rest_list "$2"
    ;;
  -s)
    # -s <remote-file> [local-dest]
    #   with dest  -> saves to that local file (binary-safe, byte-exact)
    #   without    -> prints to stdout (backwards compatible, "cat"-like)
    [[ $# -lt 2 ]] && die "-s requires <remote-file> [local-dest]"
    if [[ $# -ge 3 ]]; then
      curl -s -A "$UA" -H "Authorization: Bearer $AK" "${REST_BASE}/files/download?path=$2" -o "$3"
      echo "r2.sh: saved $2 -> $3 ($(wc -c < "$3") B)"
    else
      rest_download "$2"
    fi
    ;;
  -w)
    [[ $# -lt 3 ]] && die "-w requires <remote-file> <local-file>"
    rest_upload "$2" "$3"
    ;;
  -delf)
    [[ $# -lt 2 ]] && die "-delf requires file path"
    rest_delete "$2"
    ;;
  -p)
    # Upload a local git-patch file and apply it (common language)
    [[ $# -lt 2 ]] && die "-p requires <local-patch-file> [remote-patch-path] [repo-dir]"
    local_patch="$2"
    remote_patch="${3:-/workspace/$(basename "$2")}"
    repo_dir="${4:-}"
    [[ -f "$local_patch" ]] || die "local patch not found: $local_patch"
    echo "r2.sh: uploading patch $(basename "$local_patch") ($(wc -c < "$local_patch") bytes) ..."
    rest_upload "$remote_patch" "$local_patch"
    echo "r2.sh: uploaded to $remote_patch"
    # Run gitpatch REMOTELY via WSS (the sandbox has it at /workspace/gitpatch)
    if [[ -n "$repo_dir" ]]; then
      remote_cmd="/workspace/gitpatch \"$remote_patch\" \"$repo_dir\""
    else
      remote_cmd="/workspace/gitpatch \"$remote_patch\""
    fi
    wss_exec "$(python3 -c 'import json,sys; print(json.dumps({"type":"start","command":sys.argv[1],"__token":sys.argv[2]}))' "$remote_cmd" "$SSH_TOKEN")"
    ;;
  --ship)
    # ONE command: git add/commit/push + gh pr create, run inside the sandbox
    # r2.sh --ship [--dry-run] <repo-dir> <branch> "title" [issue] [body]
    [[ $# -lt 4 ]] && die "--ship requires [--dry-run] <repo-dir> <branch> \"title\" [issue] [body]"
    shift  # drop --ship
    remote_cmd=$(python3 -c '
import shlex, sys
args = sys.argv[1:]
print("bash /workspace/ship.sh " + " ".join(shlex.quote(a) for a in args))
' "$@")
    wss_exec "$(python3 -c 'import json,sys; print(json.dumps({"type":"start","command":sys.argv[1],"timeout":300,"__token":sys.argv[2]}))' "$remote_cmd" "$SSH_TOKEN")"
    ;;
  --claim|--complete|--update|--pool-status)
    # Pool ops run INSIDE the box against its local replica (/workspace/r.sh
    # bootstraps it via pool.sh --ensure). r2.sh's own SSH token is not needed
    # for these — only the box shell.
    [[ $# -lt 2 ]] && die "$1 requires arguments: $1 <taskId> [value]"
    remote_cmd=$(python3 -c '
import shlex, sys
args = sys.argv[1:]
print("bash /workspace/r.sh " + " ".join(shlex.quote(a) for a in args))
' "$@")
    wss_exec "$(python3 -c 'import json,sys; print(json.dumps({"type":"start","command":sys.argv[1],"__token":sys.argv[2]}))' "$remote_cmd" "$SSH_TOKEN")"
    ;;
  -h|--help)
    sed -n '4,21p' "$0" | sed 's/^# //' | sed 's/^#//'
    ;;
  *)
    wss_exec "$(python3 -c 'import json,sys; print(json.dumps({"type":"start","command":sys.argv[1],"__token":sys.argv[2]}))' "$*" "$SSH_TOKEN")"
    ;;
esac
