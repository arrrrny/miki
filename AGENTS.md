# AGENTS.md — miki

> Read this first if you are an AI coding agent about to work on miki. It assumes
> you know nothing about the project.

## Project overview

**miki** ("Inverse Kimi") is a tiny, **provider-free coding tool server** for cloud
agents. There is no LLM, no API key, and no model inside miki — the thing that
connects to it *is* the provider.

The mental model used throughout the codebase (see `server.mjs`, `README.md`):

- **Cloud agent = the surgeon (the brain).** It brings its own LLM and decides what
  to build.
- **miki = the Da Vinci arms (the hands).** It does not think. It takes the
  surgeon's intent and performs it with precision inside the box.
- **The box = the sandbox (e.g. a Daytona workspace).** Where code gets built.

Every miki tool is a 1:1 mirror of a **kimi** command. When an agent calls
`read_file`, miki performs it inside the box *as if kimi itself issued `Read`*. The
effect is identical; only the brain is elsewhere. This kimi mapping is the central
contract of the project and is carried on every tool and in `GET /tools`.

- Repo: `github.com/arrrrny/miki`
- Related paradigms: **GYM** (`github.com/arrrrny/gym`) — a two-phase operator gate;
  **DROP CARD** (`github.com/arrrrny/drop-card`) — a mis-fire capture concept.

## Technology stack & runtime

- **Node.js**, native **ES modules** (`"type": "module"`, all source is `.mjs`).
  No bundler, no transpiler, no TypeScript. You run the files directly with `node`.
- **Single runtime dependency:** `ws` (WebSocket server/client). Everything else is
  from `node:` builtins (`http`, `https`, `fs`, `path`, `crypto`, `child_process`).
- **TLS:** the server is HTTPS + WSS using a **self-signed cert** in `certs/`
  (`key.pem` + `cert.pem`), generated once via `npm run certs`. Clients connect with
  `rejectUnauthorized: false` against this local cert (swap in real certs for
  production). The certs dir is gitignored.
- **No build step.** `npm start` just runs `node server.mjs`.
- Default listen port **7654**.

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `MIKI_PORT` | `7654` | Listen port for the HTTPS+WSS server. |
| `MIKI_ROOT` | project dir | The sandbox root; all file tools are confined under it. |
| `MIKI_AUTH_SECRET` | `dev-secret-change-me` | Bearer secret that gates `POST /session` and `GET /transcript`. **Change before any non-localhost exposure.** |
| `MIKI_SKILLS_DIR` | `<root>/skills` | Directory the `skills` arm reads playbooks from. |
| `DAYTONA_WORKSPACE_URL` / `DAYTONA_PUBLIC_URL` / `MIKI_PUBLIC_URL` | — | Public base URL bootstrap.mjs prints for the connecting agent. Falls back to `https://localhost:<port>`. |
| `MIKI_GYM_EXERCISES` | — | Set to `skip` to run warmup only. |
| `MIKI_GYM_TIMEOUT` | `300` | Max seconds `gym.mjs` waits for a `.submitted` marker. |
| `MIKI_SELF_DRIVE` | — | Set to `1` to let `gym-driver.mjs` auto-fulfill every GYM exercise. |
| `MIKI_DROP_CARD` | — | Set to `1` to auto-fire `drop.mjs` on every GYM mis-fire. |

## Code organization / module divisions

| File | Role |
|------|------|
| `server.mjs` | **Core.** HTTPS+WSS server, tool registry, REST handlers, unified WSS session, session auth, kimi transcript, exec streaming. Exports `createServer`, `restHandler`, `AUTH_SECRET`, `tools`, `invokeTool`, `runExec`, `issueToken`, `sessionForToken`, `transcript`. |
| `mcp.mjs` | **MCP server over SSE.** `attachMcp(server, { tools, invokeTool, runExec, sessionForToken })`. Exposes every arm as an MCP tool with its `kimi:` mapping; `exec` streams as `notification/progress`. |
| `bootstrap.mjs` | Launches miki in a sandbox, derives the public connect URL, prints it. |
| `agent.mjs` | Demo cloud-agent over **REST** (lists tools, reads a file). |
| `agent-ws.mjs` | Demo cloud-agent over a **unified WSS session** (auth + read/write/list/exec). |
| `mcp-client.mjs` | Minimal **MCP-over-SSE client** demo (the surgeon's plug-in). |
| `demo.mjs` | Spawns the server, runs a REST agent read, exits. |
| `gym.mjs` | **GYM runner:** two-phase warmup + graded exercises + the promotion gate. |
| `gym-driver.mjs` | **SELF-DRIVE** agent (`MIKI_SELF_DRIVE=1`) that fulfills every exercise via miki tools and drops `.submitted`. |
| `drop.mjs` | **DROP CARD** helper — capture a mis-fire as `drops/DROP-<agent>-<date>.md` + optional GitHub issue. |
| `gym/` | Warmup reps (`<id>-<name>.mjs`, each `export default`s an object with `verify(ctx)`) and graded exercises (`exercise-*.mjs`, each with `evaluate(workspace)`). |
| `skills/` | Skill playbooks as `<name>/SKILL.md`, each with YAML frontmatter (`name`, `description`). |
| `dart_demo/stream.dart` | A `dart test`-style streaming script (no `pub get`) used to demonstrate live WSS output. |
| `sample.txt` | Demo file the REST agent reads. |
| `test/` | `node:test` suites — `tools.test.mjs`, `wss.test.mjs`, `mcp.test.mjs`. |
| `certs/` | Local self-signed TLS cert (gitignored; `npm run certs`). |
| `.sessions/` | Per-agent isolated workspaces (gitignored; created at runtime). |
| `drops/` | DROP CARD output (gitignored; runtime). |

## The tool surface (kimi mapping contract)

| miki tool | kimi command | transport |
|-----------|--------------|-----------|
| `read_file` | `Read` | REST / WSS / MCP |
| `write_file` | `Write` | REST / WSS / MCP |
| `edit` | `Edit` | REST / WSS / MCP |
| `multiedit` | `MultiEdit` | REST / WSS / MCP |
| `list_files` | `Glob` | REST / WSS / MCP |
| `grep` | `Grep` | REST / WSS / MCP |
| `exec` | `Bash` | **WSS / MCP only** (streaming) |
| `skills` | `Skill` | REST / WSS / MCP |

`exec` is **deliberately rejected over REST** — it is a streaming tool (like
`dart test`) and MUST ride WSS or MCP. The rejection message tells the caller to use
WSS/MCP.

### Transports

- **REST (HTTPS)** — file tools + session ops:
  `GET /` (health) · `GET /tools` (tool list w/ kimi mapping) ·
  `POST /tools/call` `{tool,args}` → `{ok,result}` ·
  `POST /session` (Bearer) → `{token, sessionId, workspace}` ·
  `GET /transcript` (Bearer) → kimi-command audit log ·
  `POST /promote` (Bearer token) → clears session, returns `controlToken` + workspace + tools ·
  `GET /status` → `{cleared, sessionId}`.
- **WSS (WSS)** — `/ws?token=<token>`. One socket drives everything:
  `{type:"call",id,tool,args}` → `{type:"result",id,...}` for non-streaming tools;
  `{type:"start",command,cwd?,timeout?}` → `stdout`/`stderr`/`exit`/`error` frames for `exec`.
- **MCP-over-SSE (HTTPS)** — `/mcp?token=<token>`. SSE stream + `endpoint` event
  telling the client where to POST JSON-RPC. Methods: `initialize`, `tools/list`,
  `tools/call`. `exec` streams as `notification/progress` frames.

### Auth + isolation

- `POST /session` with `Authorization: Bearer <MIKI_AUTH_SECRET>` returns a hex
  `token` + an isolated `workspace` (a per-session dir under `MIKI_ROOT/.sessions/<uuid>`),
  or — if the delegator passes a `workspace` body that lives inside `MIKI_ROOT` — an
  anchored workspace on an existing repo.
- WSS and MCP connections **require a valid `?token=`** (or Bearer) or are rejected.
- A token-less `POST /tools/call` operates at `MIKI_ROOT` (admin/debug convenience);
  a tokened call is scoped to that agent's workspace (WSS parity).
- Concurrent agents never collide — each is sandboxed to its own session dir.

## GYM (grow your muscles)

The GYM is a gate that only *proven* operators may pass. `node gym.mjs` (miki must
already be live on `MIKI_PORT`):

1. **Phase 1 — WARMUP.** Each `gym/<id>-<name>.mjs` exposes `verify(ctx)`; the runner
   opens one session and proves the agent can auth, write, read, exec, and audit. No
   reps passed → `process.exit(1)`, no exercises.
2. **Phase 2 — EXERCISES.** Each `gym/exercise-*.mjs` exposes `evaluate(workspace)`.
   The runner hands the agent its workspace URL + token, then the agent builds solo
   and drops a `.submitted` marker. The runner then grades the *submission*
   (`evaluate`), not miki's code.
3. **GATE OPEN.** When all exercises pass, the runner calls `POST /promote` with the
   session token → miki clears the session and returns a `controlToken` + workspace +
   tool surface. That is the moment the surgeon is handed the arms.

Flags: `MIKI_GYM_EXERCISES=skip` (warmup only), `MIKI_GYM_TIMEOUT=30` (cap wait at
30s), `MIKI_SELF_DRIVE=1` (auto-fulfill via `gym-driver.mjs`),
`MIKI_DROP_CARD=1` (auto-fire DROP CARD on every mis-fire).

## DROP CARD

A mis-fire is not a mistake — it is a discovery. Capture it with:

```bash
node drop.mjs --agent <id> --did "<X>" --expected "<Y>" --happened "<Z>" \
  [--where "<context>"] [--discovery]
```

Writes `drops/DROP-<agent>-<date>.md` and, if `gh` is available, opens a GitHub
issue. Two redundant copies of the same card.

## Build & run commands

```bash
npm run certs        # one-time: generate self-signed localhost certs into certs/
npm start            # start the HTTPS+WSS server on :7654
npm run bootstrap    # launch in a sandbox and print the cloud-agent connect URL
npm run demo         # spawn server + run REST agent, then exit
npm run demo:ws      # run the WSS cloud-agent demo (agent-ws.mjs)
npm run demo:mcp     # run the MCP-over-SSE client demo (mcp-client.mjs)
node gym.mjs        # run the GYM (miki must be live)
```

## kimi — the inverse-kimi TELEPORTER (miki)

`kimi.mjs` is the **custom kimi client shipped in this repo** (built from the
project's GitHub) — **not** an npm package. Run it directly with `node kimi.mjs`;
never `npm install kimi`.

miki is provider-free: the cloud agent *is* the provider, and `kimi` is how it
reaches the sandbox **without ever cloning the repo**. `kimi` runs on the cloud
agent's own **outer-layer** machine (it does **not** live inside Daytona); from
there it SSHes into the sandbox (a GCP box / Daytona workspace) as a true
teleporter. The agent downloads only `kimi.mjs`, sets env once, and then its
commands run *inside the box*. `kimi s ls` lists the box; `kimi s "cargo check"`
builds on the box; `kimi s git …` touches the box repo. This kills the
download-the-whole-repo → edit-locally → upload-diff anti-pattern: the agent
never holds the code, it holds a shell into the box.

**SSH overlay (primary transport).** When `MIKI_SSH_*` is set, `kimi` opens ONE
long-lived `ssh2` connection (pure-JS, no system `ssh` binary) held by a local
daemon (unix socket `~/.kimi_ssh.sock`). Every `kimi s`/`read`/`write`/… talks
to that daemon instead of re-handshaking — so the box feels like a local shell:
**connect once, then commands just flow.** The Daytona WSS/REST proxy remains the
fallback when only `MIKI_SID`/`MIKI_API_KEY` are set. Run `kimi --ssh-stop` to
kill the local daemon.

### The teleporter (primary interface)

`kimi s <cmd>` runs `<cmd>` in the Daytona workspace. A persisted cwd
(`~/.kimi_teleport`) makes `kimi s cd /workspace/herdr` then `kimi s ls` behave
like one continuous session — the agent "is in the box."

```bash
npm run kimi -- s pwd                              # print current box cwd
npm run kimi -- s cd /workspace/herdr              # move (persisted) — next `s` runs there
npm run kimi -- s ls                               # list the box workspace
npm run kimi -- s "cargo check"                   # build on the box (piped fine: | head)
npm run kimi -- s "git branch --show-current"     # any shell command, on the box
```

### File ops / pool lifecycle / in-box miki (secondary subcommands)

```bash
npm run kimi -- check                              # connectivity check (SSH/REST)
npm run kimi -- speckit <phase|args...> [-d <dir>] [-t <secs>]  # run SDD on the box: phases specify|plan|tasks|implement (skills) or any specify subcommand
npm run kimi -- goal "<objective>" [-d <dir>]           # write a durable GOAL.md contract on the box (kimi /goal mirror); kimi goal prints it
npm run kimi -- read /workspace/herdr/Cargo.toml    # download file (r.sh -s)
npm run kimi -- write /workspace/x.txt "hello"      # write file from args
npm run kimi -- upload /workspace/x.txt ./x.txt     # binary-safe upload
npm run kimi -- list /workspace                     # list dir (r.sh -l)
npm run kimi -- delete /workspace/x.txt             # delete file
npm run kimi -- claim <taskId>                      # pool: claim task
npm run kimi -- update <taskId> "<msg>"             # pool: status update
npm run kimi -- complete <taskId> <prUrl>           # pool: complete task
npm run kimi -- ship <repo> <branch> "<title>" [issue]  # open PR via ship.sh
npm run kimi -- serve                               # boot in-box miki (:7654)
npm run kimi -- session [<workspace>]               # create miki session token
npm run kimi -- tool read_file '{"path":"Cargo.toml"}' --workspace /workspace/herdr
```

### Credentials & environment

Set **once** as env (the delegator supplies them — nothing is baked into the
file). `kimi.mjs` prefers the **SSH overlay** when `MIKI_SSH_*` is present;
otherwise it falls back to the Daytona proxy via `MIKI_SID`/`MIKI_API_KEY`. It
resolves in order: explicit env → `POOL_*` env → `run/.pool_env`.

**SSH overlay (preferred):**

| Var | Purpose |
|-----|---------|
| `MIKI_SSH_HOST` | box hostname / IP (e.g. `34.72.35.255`). |
| `MIKI_SSH_PORT` | ssh port (default `22`). |
| `MIKI_SSH_USER` | login user (e.g. `agent`). |
| `MIKI_SSH_KEY` | path to an ed25519 private key **or** |
| `MIKI_SSH_KEY_B64` | base64 of that key (no file needed). |

**Daytona proxy (fallback when SSH is not configured):**

| Var | Purpose |
|-----|---------|
| `MIKI_SID` | Daytona toolbox session id. |
| `MIKI_API_KEY` | the `dtn_` key — used for the proxy REST file ops **and** the proxy `process/exec/connect` WSS (Bearer). |
| `MIKI_SSH_TOKEN` | (optional) the box's native-SSH token — a separate transport layer, not sent on the proxy WSS. |

> Auth note: the proxy's `process/exec/connect` WSS authenticates with the
> `dtn_` API key (Bearer), **not** the shared SSH token. The shared token is for
> the box's native SSH and is a different layer. If a WSS call returns 401 with
> the API key, the session/token is the problem — not a missing SSH token.

### r.sh / r2.sh parity

- `s <cmd>` / `exec` → with the SSH overlay, this runs over the persistent `ssh2`
  daemon (one connection, reused); without it, the WSS `process/exec/connect`
  stream (r2.sh). Multi-command stdout is fully drained before exit, and EPIPE
  (piped to `head`/`grep`) is handled, so nothing is truncated or crashed on a pipe.
- `read`/`write`/`upload`/`list`/`delete` → with the SSH overlay, these go over
  **SFTP** on the same `ssh2` connection; otherwise the proxy REST `/files*`.
- `claim`/`update`/`complete`/`ship` → the in-box pool replica at `localhost:9999`
  (same endpoints r.sh hits), reached via box exec.
- `serve`/`session`/`tool` → optional: boot miki's in-box server and call its
  sandbox-safe, kimi-mapped tools (`read_file`, `grep`, `edit`, …) through the
  proxy instead of raw shell.

> The in-box miki `grep` enumerates the whole tree and reads each file; on a large
> repo (e.g. a Rust `target/`) it is bounded (skips build/binary dirs, caps file
> size + match count) so one call can never OOM and kill the shared server. For
> big-repo searches prefer `kimi s "rg <pat>"`.


> The in-box miki `grep` enumerates the whole tree and reads each file; on a large
> repo (e.g. a Rust `target/`) it is bounded (skips build/binary dirs, caps file
> size + match count) so one call can never OOM and kill the shared server. For
> big-repo searches prefer `kimi exec "rg <pat>"`.


## Testing

- Framework: Node's built-in **`node:test`** + **`node:assert/strict`**. No test
  runner dependency.
- Run the whole suite:

  ```bash
  npm test            # == node --test test/*.test.mjs
  ```

- Suites:
  - `test/tools.test.mjs` — tool registry + `invokeTool` directly (kimi mapping,
    read/write round-trip, path-escape rejection, REST exec rejection, `skills` arm).
  - `test/wss.test.mjs` — live server on an ephemeral port (`server.listen(0)`):
    session 401, token issue, WSS token rejection, unified session calls, streaming
    exec, **two-agent isolation**, transcript audit.
  - `test/mcp.test.mjs` — MCP-over-SSE handshake + `tools/list` / `tools/call` /
    streaming `exec`.
- **The suites need the self-signed certs present** (`npm run certs` once). They
  import `createServer` from `server.mjs` and connect with
  `rejectUnauthorized: false`. Always spin the server down in a `finally` /
  `t.after` block (close `wss` then `server`).
- **Verified state:** `npm test` currently passes all 22 tests (0 failures).

When adding a tool in `server.mjs`, add a `kimi` mapping test in `tools.test.mjs`
and, for transport behavior, in `wss.test.mjs` / `mcp.test.mjs` as appropriate.

## Code style conventions

- **ESM, `.mjs` extensions**, imports from `node:` builtins plus the local `ws`.
- **Top-of-file comment blocks** explain the "inverse kimi" / "Da Vinci arms"
  metaphor and the transport model. Match this voice when touching server code.
- **Every tool in the `tools` registry** declares `kimi`, `transport`, `description`,
  and `input` (a `{ arg: 'description' }` map). The `kimi` mapping is the contract —
  do not add a tool without one.
- **Sandbox safety is non-negotiable.** Every file-path tool resolves the path
  against `root` and rejects escapes with `path escapes sandbox root`. `exec` validates
  `cwd` the same way and `SIGKILL`s the child on timeout. Keep this when editing.
- **Audit everything.** Every call (success or failure) is recorded via `recordEntry`
  into the `transcript` array as a kimi-style entry (`sessionId`, `kimi`, `tool`,
  `args`, `transport`, `ok`, `result?|error?`, `exitCode?`). New transports must feed
  the transcript so `GET /transcript` stays honest.
- **`exec` runs with `shell: true`** and sets `MIKI_ROOT` in the child env to the
  resolved cwd. It is the only tool exposed over WSS/MCP, never REST.

## Security considerations

- `MIKI_AUTH_SECRET` defaults to `dev-secret-change-me`. **Set it before exposing
  miki to anything but localhost** — it is the only thing gating token issuance and
  the transcript.
- **Path traversal** is defended at every file tool and on `exec`'s `cwd`; tests
  assert the `escapes sandbox root` rejection. Preserve and extend these guards.
- **Session isolation** is the core safety property: each agent is confined to its
  own workspace dir. Proof: `test/wss.test.mjs` "two agent sessions are isolated".
- The self-signed cert means `rejectUnauthorized: false` is used **for local dev
  only**. Production deployments must supply real certs.
- `exec` spawns a shell on the agent's behalf — confined to the workspace cwd and
  killed on timeout, but it is still arbitrary command execution behind the token.
- Per the operator guide (`MIKI_GUIDE.md`): never download a GitHub PAT into the box;
  ship work through the normal box/PR flow.
