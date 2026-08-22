#!/usr/bin/env bash
# setup_miki.sh — cloud-agent bootstrap for the miki teleporter.
#
# The agent runs ONLY this file (downloaded once). It performs NO manual SSH
# key / base64 handling: the shared build-box agent key is embedded below as a
# single-line base64 and decoded with `tr -d '[:space:]'` so a stray newline or
# space can never corrupt it (the classic copy-paste failure mode).
#
# WHAT THIS DOES
#   1. Installs miki into $HOME/miki (git clone, or curl fallback if no git)
#   2. npm install — pulls the pure-JS ssh2 overlay (NO system ssh binary needed)
#   3. Writes the shared build-box agent key to ~/.ssh/id_ed25519
#   4. Writes $HOME/miki.env with the MIKI_SSH_* exports (source it every shell)
#   5. Verifies the tunnel: `node $HOME/miki/kimi.mjs check` -> "SSH: OK"
#
# USAGE (agent)
#   bash setup_miki.sh
#   source $HOME/miki.env            # in EVERY new shell
#   node $HOME/miki/kimi.mjs check   # must print: SSH: OK
#
# After that, miki IS your shell into the box — e.g.
#   node $HOME/miki/kimi.mjs s 'ls /workspace'
#   node $HOME/miki/kimi.mjs issue arrrrny/zorphy#109
set -euo pipefail

# ---- build-box connection (delegator sets these once) ----
export MIKI_SSH_HOST="34.173.163.177"
export MIKI_SSH_PORT="2222"
export MIKI_SSH_USER="agent"

# Embedded agent ed25519 private key, single-line base64 (no newlines).
MIKI_SSH_KEY_B64="LS0tLS1CRUdJTiBPUEVOU1NIIFBSSVZBVEUgS0VZLS0tLS0KYjNCbGJuTnphQzFyWlhrdGRqRUFBQUFBQkc1dmJtVUFBQUFFYm05dVpRQUFBQUFBQUFBQkFBQUFNd0FBQUF0emMyZ3RaVwpReU5UVXhPUUFBQUNBR0cvTW5rcU9nM1U4ZFcybi9UeTdSSkNQd3hMRVh5S3RCNW5kWEdFMTRxUUFBQUpqZXdMdlYzc0M3CjFRQUFBQXR6YzJndFpXUXlOVFV4T1FBQUFDQUdHL01ua3FPZzNVOGRXMm4vVHk3UkpDUHd4TEVYeUt0QjVuZFhHRTE0cVEKQUFBRURQWFl5UHBmVjhubU10YjJqV25qL1VXMjhpUCszQktILzgydzhBV0lkNUZRWWI4eWVTbzZEZFR4MWJhZjlQTHRFawpJL0RFc1JmSXEwSG1kMWNZVFhpcEFBQUFFRzFwYTJrdFkyeHZkV1F0WVdkbGJuUUJBZ01FQlE9PQotLS0tLUVORCBPUEVOU1NIIFBSSVZBVEUgS0VZLS0tLS0K"

MIKI_DIR="${MIKI_DIR:-$HOME/miki}"

echo "[setup_miki] 1/5  installing miki into $MIKI_DIR"
if [ ! -f "$MIKI_DIR/kimi.mjs" ]; then
  MIKI_REPO_TOKEN="${MIKI_REPO_TOKEN:-}"   # set a read-only PAT so the agent can clone the PRIVATE repo
  if command -v git >/dev/null 2>&1; then
    if [ -n "$MIKI_REPO_TOKEN" ]; then
      git clone --depth 1 "https://x-access-token:${MIKI_REPO_TOKEN}@github.com/arrrrny/miki" "$MIKI_DIR"
    else
      git clone --depth 1 https://github.com/arrrrny/miki "$MIKI_DIR"
    fi
  else
    mkdir -p "$MIKI_DIR"
    if [ -n "$MIKI_REPO_TOKEN" ]; then
      curl -fsSL -H "Authorization: Bearer ${MIKI_REPO_TOKEN}" https://raw.githubusercontent.com/arrrrny/miki/master/kimi.mjs     -o "$MIKI_DIR/kimi.mjs"
      curl -fsSL -H "Authorization: Bearer ${MIKI_REPO_TOKEN}" https://raw.githubusercontent.com/arrrrny/miki/master/package.json -o "$MIKI_DIR/package.json"
    else
      curl -fsSL https://raw.githubusercontent.com/arrrrny/miki/master/kimi.mjs     -o "$MIKI_DIR/kimi.mjs"
      curl -fsSL https://raw.githubusercontent.com/arrrrny/miki/master/package.json -o "$MIKI_DIR/package.json"
    fi
  fi
else
  echo "[setup_miki]        miki already present"
fi

echo "[setup_miki] 2/5  npm install (ssh2 overlay)"
( cd "$MIKI_DIR" && npm install --no-audit --no-fund --silent )

echo "[setup_miki] 3/5  writing agent key to ~/.ssh/id_ed25519"
mkdir -p "$HOME/.ssh"
printf '%s' "$MIKI_SSH_KEY_B64" | tr -d '[:space:]' | base64 -d > "$HOME/.ssh/id_ed25519"
chmod 600 "$HOME/.ssh/id_ed25519"

echo "[setup_miki] 4/5  writing $HOME/miki.env"
cat > "$HOME/miki.env" <<ENV
export MIKI_SSH_HOST="$MIKI_SSH_HOST"
export MIKI_SSH_PORT="$MIKI_SSH_PORT"
export MIKI_SSH_USER="$MIKI_SSH_USER"
export MIKI_SSH_KEY="\$HOME/.ssh/id_ed25519"
export PATH="\$HOME/miki:\$PATH"
ENV

echo "[setup_miki] 5/5  verifying tunnel"
# shellcheck disable=SC1090
source "$HOME/miki.env"
node "$MIKI_DIR/kimi.mjs" check
echo "[setup_miki] done. source \$HOME/miki.env in every shell, then:"
echo "                node \$HOME/miki/kimi.mjs s 'ls /workspace'"
