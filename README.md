# miki

**Inverse Kimi.**

Kimi is a coding agent that *asks you for a provider* (an LLM API key / model)
so it can think, then drives your local tools.

**miki is the reverse.** It does **not** ask for a provider, because the thing
connecting to it *is* the provider. miki is a tiny, provider-free **coding tool
server**: it exposes the *hands* (read a file, and later write/exec), and a
**cloud agent** connects, brings its own brain, and codes inside the sandbox —
exactly like kimi would, but without miki ever needing a model or an API key.

```
   KIMI                                  MIKI
   ────                                  ────
   you ──provider?──> asks for LLM       cloud agent ──(already has a brain)──┐
   you ──runs kimi──> kimi drives tools                                   │
                                         miki = tool server (no provider) ◄┘
                                         agent = the one that thinks
```

## Architecture — the Da Vinci model

```
        surgeon (brain)                robotic arms (hands)
   ┌────────────────────┐        ┌──────────────────────────┐
   │  cloud agent       │  maps  │  miki                     │
   │  (its own LLM)     │ ─────► │  provider-free tool srv  │
   └────────────────────┘        └────────────┬─────────────┘
                                               │ executes inside the box
                                               ▼
                                    ┌──────────────────────────┐
                                    │  the box (Daytona sandbox)│
                                    │  = kimi session field     │
                                    └──────────────────────────┘
```

- **Cloud agent = the surgeon.** It brings the brain (its own LLM). It never
  configures a provider inside miki.
- **miki = the Da Vinci arms.** It does not think. It takes the surgeon's intent
  and performs it with precision inside the box.
- **The box = the surgical field.** The Daytona sandbox where code gets built —
  the same place kimi would operate.
- **The mapping = intent → kimi command.** Every miki tool is a 1:1 mirror of a
  kimi command. When the agent calls `read_file`, miki's arms perform it inside
  the box *as if kimi itself issued `Read`*. The effect in the box is identical;
  only the brain is elsewhere.

This is why miki needs no provider: the surgeon (agent) already has one. miki is
just the arms that make the surgeon's moves land correctly in the box.

### kimi-command mapping

| miki tool     | kimi command | transport | status |
|---------------|--------------|-----------|--------|
| `read_file`   | `Read`       | REST      | done   |
| `write_file`  | `Write`/`Edit` | REST    | done   |
| `list_files`  | `Glob`       | REST      | done   |
| `exec`        | `Bash`       | WSS (stream) | done |
| *(unified WSS session)* | all of the above over one socket | WSS | done |
| *(agent sessions + auth)* | isolated workspace + token per agent | REST+WSS | done |
| *(kimi transcript)* | auditable session log (each call as a kimi command) | — | done |

Each tool carries its `kimi` mapping in `GET /tools`, so a connecting agent (and
a human auditing the box) can see exactly which kimi command each arm mirrors.

## The contract

miki speaks plain JSON. **One secure base** (mirrors r2.sh): file tools over
REST (HTTPS), streaming exec over WSS (WSS). No auth, no model, no provider.

```
REST (HTTPS)
  GET  /            -> { name, tagline, tools }
  GET  /tools       -> list of tools (name, kimi mapping, transport)
  POST /tools/call  -> { "tool":"read_file", "args":{ "path":"sample.txt" } }
                     -> { "ok": true, "result": "<file contents>" }
  POST /session     -> Authorization: Bearer <MIKI_AUTH_SECRET>
                     -> { "ok":true, "token":"<hex>", "sessionId":"<uuid>",
                          "workspace":"<MIKI_ROOT>/.sessions/<uuid>" }
  GET  /transcript  -> Authorization: Bearer <MIKI_AUTH_SECRET>
                       ?session=<uuid>  (omit to get the whole log)
                     -> { "ok":true, "count":N, "entries":[ { ts, sessionId,
                          kimi:"Read"|"Write"|"Glob"|"Bash", tool, args,
                          transport, ok, result?|error?, exitCode? } ] }

WSS (WSS)  /ws?token=<token>   streaming exec — like kimi's Bash, frames arrive over time
  client -> { "type":"start", "command":"dart test", "cwd"?:"", "timeout"?":N }
  server -> { "type":"stdout", "data":"..." }
            { "type":"stderr", "data":"..." }
            { "type":"exit",   "exitCode": 0 }
            { "type":"error",  "message":"..." }

  Non-streaming tools share the same socket (unified session), scoped to the
  agent's isolated workspace (not the global root):
  client -> { "type":"call", "id":1, "tool":"read_file", "args":{ "path":"x" } }
  server -> { "type":"result", "id":1, "ok":true, "tool":"read_file", "result":"..." }
            | { "type":"result", "id":1, "ok":false, "error":"..." }
```

Connecting agents **must** authenticate: `POST /session` with
`Authorization: Bearer <MIKI_AUTH_SECRET>` to get a token + isolated workspace,
then attach that token as the WSS query param (`/ws?token=...`). A WSS connection
without a valid token is rejected immediately. `MIKI_AUTH_SECRET` defaults to
`dev-secret-change-me` — set it before exposing miki to anything but localhost.

Tools are confined to the agent's workspace (a per-session dir under
`MIKI_ROOT/.sessions/<uuid>`), so concurrent cloud agents never collide and can
only touch files inside their own box. The plain `/tools/call` REST endpoint is a
global-root convenience for one-shot calls; the WSS session is the authenticated,
isolated path a real cloud agent uses. WSS client connects with
`rejectUnauthorized:false` against the local self-signed cert (swap in real certs
for production).

### WSS over HTTPS (the r2.sh model)

`exec` is a **streaming** tool — it mirrors kimi's `Bash` and, like `dart test`,
emits output line by line over time. That is why it rides WSS, not REST: the
surgeon (agent) watches the arms (miki) work live, the same way r2.sh streams a
remote command over `wss://…/process/exec/connect`.

```
 agent ──WSS /ws──► miki.exec ──spawn──► command in box
   ▲                   │ streams frames
   └──── stdout/stderr/exit ──┘
```

## Run it

```bash
cd miki
npm run certs             # one-time: generate self-signed localhost certs
npm start                 # starts the HTTPS+WSS server on :7654
```

Bootstrap for a sandbox (Daytona / any box). It generates a fresh
`MIKI_AUTH_SECRET` (or uses yours), launches miki, and prints the connect URL
the cloud agent needs:

```bash
npm run bootstrap
# or: MIKI_AUTH_SECRET=... DAYTONA_WORKSPACE_URL=https://<box> npm run bootstrap
```

REST read (self-signed cert -> `curl -k`):

```bash
curl -sk https://localhost:7654/tools
curl -sk -X POST https://localhost:7654/tools/call \
  -H 'content-type: application/json' -d '{"tool":"read_file","args":{"path":"sample.txt"}}'
```

Streaming exec over WSS — watch a `dart test`-style command run live:

```bash
node agent-ws.mjs "dart run dart_demo/stream.dart"
# or just: npm run demo:ws
```

Or run server + REST agent together as one demo:

```bash
npm run demo
```

## How a cloud agent actually uses it

The `agent.mjs` / `agent-ws.mjs` demos are stand-ins for a real LLM-driven agent.
A real cloud agent connects to miki like this:

1. `POST /session` with `Authorization: Bearer <MIKI_AUTH_SECRET>` → receives a
   token + its own isolated workspace.
2. Open `WSS /ws?token=<token>` — one socket drives every tool.
3. Loop: decide what to build → `call` `read_file` / `write_file` / `list_files`
   or `start` `exec` → observe the (streamed) result → repeat.
4. Inspect `GET /transcript` to audit what the arms performed as kimi commands.
5. Never configure a provider — miki has none, and the agent carries its own.

That is the inverse of kimi: kimi *is* the agent and needs a provider to think;
miki *is* the environment and the connecting agent is the thinker. The box
(Daytona sandbox) is the surgical field, identical to where kimi would operate.

## GYM — grow your muscles

Before a cloud agent is allowed to drive miki and control kimi, it completes
the miki **GYM**: a two-phase forge. GYM is not a test of miki — it is a test
of the operator. Warmup grows the muscle. Exercises prove it under load. The
gate only lets the proven through.

```bash
node gym.mjs                              # miki must be live; warms up then grades
MIKI_GYM_EXERCISES=skip node gym.mjs      # warmup only
MIKI_GYM_TIMEOUT=30 node gym.mjs          # cap the exercise wait at 30s
```

**Phase 1 — WARMUP.** Mandatory reps in `gym/<id>-<name>.mjs` that grow the
reflexes to auth, write, read, exec, and audit. Each exposes `verify(ctx)`; the
runner opens one session and proves the agent actually did the work. No reps, no
phase 2.

**Phase 2 — EXERCISES.** Graded work in `gym/exercise-*.mjs`. The runner hands
the agent a brief + its workspace URL + token, then walks off. The agent builds
solo with the miki tools and drops a `.submitted` marker when done. The runner
then grades the submission with `evaluate(workspace)` — automated tests against
the agent's work, not miki's code. Fail and the gate stays shut; only passing
agents are cleared to control kimi.

The GYM paradigm itself — the inverse of a test suite, built to grow the
operator — is documented at
[github.com/arrrrny/gym](https://github.com/arrrrny/gym).

## Files

- `server.mjs`    — the miki tool server (HTTPS + WSS, `ws` for the socket).
- `bootstrap.mjs` — launch miki in a sandbox and print the agent connect URL.
- `agent.mjs`     — minimal cloud-agent demo over REST (lists tools, reads a file).
- `agent-ws.mjs`  — cloud-agent demo over WSS (auth + streams exec output live).
- `demo.mjs`      — spawns the server, runs the REST agent, exits.
- `gym.mjs`       — the two-phase GYM runner (warmup reps + graded exercises + gate).
- `gym/`          — warmup reps (`<id>-<name>.mjs`) and graded exercises (`exercise-*.mjs`).
- `dart_demo/stream.dart` — a `dart test`-style streaming script (no pub get).
- `sample.txt`    — a file for the demo to read.
- `certs/`        — local self-signed TLS cert (gitignored; `npm run certs`).
- `.sessions/`    — per-agent isolated workspaces (gitignored; created at runtime).

## Milestones

- [x] **M1 Tool surface** — `read_file` (Read), `write_file` (Write/Edit),
      `list_files` (Glob), `exec` (Bash, streaming); all confined to `MIKI_ROOT`.
- [x] **M2 Unified WSS session** — one WSS socket drives every tool, with
      streaming frames for `exec`; REST kept for one-shot calls.
- [x] **M3 Agent sessions & auth** — each agent gets an isolated workspace +
      token; WSS requires `?token=`.
- [x] **M4 kimi transcript** — every tool call logged as a kimi-style command
      (`GET /transcript`, Bearer-gated).
- [x] **M5 Tests** — `node --test` suite over each tool + transport; exits 0.
- [x] **M6 Bootstrap** — `bootstrap.mjs` launches miki in a sandbox and exposes
      the connect URL (Daytona `DAYTONA_WORKSPACE_URL` aware).
- [x] **M7 Docs** — this README.
