# Copy-paste agent prompt — implement kimi-code-sync spec 001 via miki

> NOTE: replace `<MIKI_SSH_KEY_B64>` with the agent private key (single-line
> base64) before handing to an agent. Do NOT commit the filled version to the
> public miki repo.

You are a cloud coding agent. Your ONLY way to touch code is the `miki` teleporter —
a tiny Node CLI that SSH-tunnels your commands into a shared build box. You NEVER
clone the repo to your machine, NEVER edit locally, NEVER upload diffs. Every
command, read, and write happens ON THE BOX over an SSH overlay. No Daytona, no
r.sh, no r2.sh.

# ---- SSH connection (delegator-supplied; NOT in any repo) ----
export MIKI_SSH_HOST="34.173.163.177"
export MIKI_SSH_PORT="2222"
export MIKI_SSH_USER="agent"
export MIKI_SSH_KEY_B64="<MIKI_SSH_KEY_B64>"

# ---- STEP 0: bootstrap miki (one time) ----
curl -fsSL https://raw.githubusercontent.com/arrrrny/miki/master/setup_miki.sh -o setup_miki.sh
bash setup_miki.sh
source "$HOME/miki.env"          # sets MIKI_SSH_*; run in EVERY new shell
node "$HOME/miki/kimi.mjs" check # must print: SSH: OK

# ---- The task ----
SPEC=/workspace/kimi-code-sync/specs/001-auto-compact-threshold/spec.md
REPO=kimi-code-sync
BASE=development                 # kimi-code-sync mainline (use master for zorphy/forklift)

# ---- STEP 1: set the durable goal (forces the full SDD cycle) ----
node "$HOME/miki/kimi.mjs" goal "Complete the spec at $SPEC using the full spec-driven \
development cycle: speckit specify, speckit plan, speckit tasks, speckit implement. \
Work ONLY inside a git worktree branched off $BASE. When done, open a PR with base $BASE."

# ---- STEP 2: ensure repo + create a worktree off $BASE (never the default checkout) ----
node "$HOME/miki/kimi.mjs" s "ls -d /workspace/$REPO 2>/dev/null || (cd /workspace && git clone https://github.com/arrrrny/$REPO.git)"
SLUG=$(basename "$SPEC" | sed 's/^[0-9]*-//')
node "$HOME/miki/kimi.mjs" s "cd /workspace/$REPO && git fetch origin && git worktree add -b agent/$SLUG ../$REPO.wt origin/$BASE"
WT=/workspace/$REPO.wt

# ---- STEP 3: run the FULL SDD cycle (all four, in order) ----
node "$HOME/miki/kimi.mjs" speckit specify "Session-Controlled Auto-Compaction Ratio" -d "$WT" -t 120
node "$HOME/miki/kimi.mjs" speckit plan    -d "$WT" -t 120
node "$HOME/miki/kimi/kimi.mjs" speckit tasks   -d "$WT" -t 120
node "$HOME/miki/kimi.mjs" speckit implement -d "$WT" -t 60

# ---- STEP 4: implement the spec in the worktree ----
# `speckit implement` surfaces the speckit-implement skill — follow it. Edit source
# in $WT via kimi read/write/s, then verify:
node "$HOME/miki/kimi.mjs" read  "$WT/path/to/file"
node "$HOME/miki/kimi.mjs" write "$WT/path/to/file" "<new content>"
node "$HOME/miki/kimi.mjs" s "cd $WT && <build/test commands>"

# ---- STEP 5: commit, push, open PR (base $BASE) ----
node "$HOME/miki/kimi.mjs" s "cd $WT && git add -A && git commit -m 'feat: <summary>' && git push -u origin agent/$SLUG"
node "$HOME/miki/kimi.mjs" s "cd $WT && gh pr create --base $BASE --head agent/$SLUG --title 'feat: <short>' --body 'Closes spec 001\n\n<what changed + how verified>'"

RULES
- Never clone to YOUR machine. If you start downloading source, stop — use kimi s.
- Always a worktree off $BASE; never touch the default checkout.
- Run the four speckit phases in order; do not skip any.
- If a kimi command fails, read the error; do not fall back to r.sh/r2.sh.
- Stop and report if blocked (missing creds, external API).
