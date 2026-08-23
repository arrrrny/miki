#!/usr/bin/env bash
# setup_miki.sh — cloud-agent bootstrap for the miki teleporter.
#
# The agent runs ONLY this file (downloaded once). It installs miki and writes
# the box agent key into ~/.ssh/id_ed25519. The SSH connection details are NOT
# baked into this script — the delegator supplies them (see the agent prompt):
#   export MIKI_SSH_HOST=...      # box IP (updates on box restart)
#   export MIKI_SSH_PORT=2222
#   export MIKI_SSH_USER=agent
#   export MIKI_SSH_KEY_B64=...   # agent private key, single-line base64
# setup_miki.sh reads them from the environment and decodes the key with
# `tr -d '[:space:]'` so a stray newline or space can never corrupt it.
#
# WHAT THIS DOES
#   1. Installs miki into $HOME/miki (git clone; curl fallback if no git)
#   2. npm install (ssh2 overlay — NO system ssh binary needed)
#   3. Writes the agent key to ~/.ssh/id_ed25519
#   4. Writes $HOME/miki.env with the MIKI_SSH_* exports (source every shell)
#   5. Verifies the tunnel: `node $HOME/miki/kimi.mjs check` -> "SSH: OK"
#
# USAGE (agent)
#   export MIKI_SSH_HOST=34.173.163.177 MIKI_SSH_PORT=2222 MIKI_SSH_USER=agent \
#          MIKI_SSH_KEY_B64="<agent key base64>"
#   bash setup_miki.sh
#   source $HOME/miki.env            # in EVERY new shell
#   node $HOME/miki/kimi.mjs check   # must print: SSH: OK
set -euo pipefail

# ---- build-box connection (supplied by the delegator via env) ----
export MIKI_SSH_HOST="${MIKI_SSH_HOST:-34.57.212.124}"
export MIKI_SSH_PORT="${MIKI_SSH_PORT:-2222}"
export MIKI_SSH_USER="${MIKI_SSH_USER:-agent}"

if [ -z "${MIKI_SSH_KEY_B64:-}" ]; then
  echo "setup_miki: MIKI_SSH_KEY_B64 is not set." >&2
  echo "  The delegator must export it before running this script, e.g.:" >&2
  echo "    export MIKI_SSH_KEY_B64=\"<single-line base64 of the agent key>\"" >&2
  exit 2
fi

MIKI_DIR="${MIKI_DIR:-$HOME/miki}"
MIKI_REPO_TOKEN="${MIKI_REPO_TOKEN:-}"   # only needed if the repo is private

echo "[setup_miki] 1/5  installing miki into $MIKI_DIR"
if [ ! -f "$MIKI_DIR/kimi.mjs" ]; then
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
