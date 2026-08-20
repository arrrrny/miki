# MIKI GUIDE

**For the forklift orchestrator — the agent that mints boxes and writes the specs cloud agents run.**

This is NOT for the cloud agent. It is for you: the one who runs forklift,
generates task specs, and hands work to cloud agents. Read it once, understand
what miki is, then use **Part C** to drop a ready-made "how to use miki" block
into every spec you delegate. That block is what the cloud agent actually reads.

miki lives at `github.com/arrrrny/miki`. The GYM paradigm it runs is at
`github.com/arrrrny/gym`. The DROP CARD mis-fire concept is at
`github.com/arrrrny/drop-card`.

---

## Why this guide exists

Today your cloud agents reach a Daytona box two ways:

- `r.sh` — a single REST/MCP HTTP call. Fast, short commands only (`git`, `ls`,
  `cat`, `sgh`). Times out on anything long.
- `r2.sh` — a WebSocket (`wss://proxy.zuzu.dev/toolbox/<SID>/process/exec/connect`)
  that streams output with no timeout. MANDATORY for `dart test`,
  `dart pub get`, `build_runner`, anything over ~60s.

That works. But it drops the agent straight into a raw shell with root-ish access
to the box. There is no gate, no warm-up, no audit of *what kimi command just
happened*, and no separation between agents.

miki is the same box, abstracted into **arms**. The cloud agent connects to miki
instead of SSH-ing the box. miki performs each move the agent wants — read a
file, write a file, run a command — inside the box *as if kimi itself issued the
kimi command*. The agent stays the brain (the surgeon); miki is the hands (the
Da Vinci arms). That gets you three things `r.sh`/`r2.sh` do not give for free:

1. **The GYM gate** — an agent must complete warm-up reps + graded exercises
   before it is allowed to operate. Only proven agents get promoted.
2. **The kimi transcript** — every move is logged as the kimi command it
   mirrored (`Read` / `Write` / `Bash` / ...), so you can audit the box after.
3. **Session isolation** — each agent gets its own workspace; concurrent agents
   never collide.

You still keep `r.sh`/`r2.sh` for raw box ops that are not kimi-shaped. miki is
the disciplined path for actual coding work.

---

## Part A — What miki is (understand it)

**Inverse kimi.** kimi asks for a provider (an LLM key) so it can think, then
drives your local tools. miki does the reverse: it does NOT ask for a provider,
because the thing connecting to it already has one. miki is a tiny,
provider-free **coding tool server**. A cloud agent connects, brings its own
brain, and codes inside the sandbox exactly like kimi would — without miki
needing a model or an API key.

```
   surgeon (brain)                robotic arms (hands)
  ┌─────────────────┐        ┌─────────────────────────┐
  │  cloud agent    │ maps   │  miki                    │
  │  (its own LLM)  │ ─────► │  provider-free tool srv │
  └─────────────────┘        └───────────┬─────────────┘
                                          │ performs inside the box
                                          ▼
                                 ┌──────────────────────┐
                                 │  the box (Daytona)   │
                                 │  = kimi session field│
                                 └──────────────────────┘
```

**The mapping.** Every miki tool is a 1:1 mirror of a kimi command. When the
agent calls `read_file`, miki's arms perform it in the box *as if kimi itself
issued `Read`*. The effect in the box is identical; only the brain is elsewhere.

| miki tool    | kimi command | transport            |
|--------------|--------------|----------------------|
| `read_file`  | `Read`       | REST                 |
| `write_file` | `Write`      | REST                 |
| `edit`       | `Edit`       | REST                 |
| `multiedit`  | `MultiEdit`  | REST                 |
| `list_files` | `Glob`       | REST                 |
| `grep`       | `Grep`       | REST                 |
| `exec`       | `Bash`       | **WSS (streaming)**  |
| `skills`     | `Skill`      | REST                 |

**Transports (one secure base, like r2.sh):**

- **REST (HTTPS)** — file tools: `GET /tools`, `POST /tools/call`, `POST /session`,
  `GET /transcript`, `POST /promote`, `GET /status`.
- **WSS (WSS)** — `/ws?token=<token>`: unified session. Non-streaming tools reply
  on the same socket; `exec` streams `stdout`/`stderr`/`exit` frames over time
  (this is why `exec` rides WSS, not REST — same reason `dart test` rides
  `r2.sh`, not `r.sh`).
- **MCP-over-SSE (HTTPS)** — `/mcp?token=<token>`: miki AS an MCP server. A
  surgeon who already speaks MCP plugs in over the protocol it knows; every
  miki tool is exposed as an MCP tool with its `kimi:` mapping, and `exec`
  streams live as `notification/progress`.

**Auth + isolation.** The agent authenticates once: `POST /session` with
`Authorization: Bearer <MIKI_AUTH_SECRET>` returns a `token` + an isolated
`workspace` (a per-session dir under `MIKI_ROOT/.sessions/<uuid>`). Every call
carries that token; tools are confined to that workspace. `MIKI_AUTH_SECRET`
defaults to `dev-secret-change-me` — set it before exposing miki to anything but
localhost.

**GYM (grow your muscles).** Before a cloud agent is allowed to drive miki, it
completes the miki GYM: a two-phase forge. Warm-up reps grow the reflex
(auth, write, read, exec, audit). Graded exercises prove it under load — the
agent builds solo and drops a `.submitted` marker; the runner grades the
submission with automated checks, not miki's code. On **GATE OPEN** the runner
calls `POST /promote` with the session token, which clears the session and hands
back a `controlToken` + workspace + tool surface. That is the moment the surgeon
is given the arms. See `github.com/arrrrny/gym`.

**Skills arm.** The inverse of kimi's `Skill` tool. `skills` with
`action:"list"` enumerates playbooks in `skills/`; `action:"get",skill:"NAME"`
returns a `SKILL.md` body the surgeon loads into *itself*, then drives the arms.
One tool, all three transports. Ships `read-and-patch` and `submit-exercise`.

**DROP CARD.** The gate is strict, but strict is not blind. If an agent hits an
unexpected outcome — a rep or exercise that does not go as planned — it STOPS
and drops a card: *I did X, expecting Y, and Z happened, SO I DROPPED.* The card
lands in `drops/DROP-<agent>-<date>.md` and a GitHub issue. A mis-fire is a
discovery, not a bug to bury. `drop.mjs` ships in this repo. See
`github.com/arrrrny/drop-card`.

---

## Part B — How miki maps onto your forklift box

Your forklift flow today:

```
  you (forklift) ──mints box──► Daytona sandbox  ◄── cloud agent SSH (r.sh / r2.sh)
                                   /workspace/<repo>
```

With miki in the loop, miki becomes the box's tool surface:

```
  you (forklift) ──mints box + launches miki (bootstrap.mjs)──► Daytona sandbox
                                                                  ├─ miki (arms)
                                                                  └─ /workspace (the box)
        cloud agent ──connects to miki (REST/WSS/MCP)──► miki performs kimi
        commands in /workspace as if kimi itself did them
```

Two wiring options, both fine:

1. **miki inside the box.** Run `npm run bootstrap` in the Daytona sandbox. miki
   launches, exposes its URL (the box URL), and uses `/workspace` (or a subdir)
   as `MIKI_ROOT`. The agent connects to miki's URL, not raw `r.sh`/`r2.sh`.
2. **miki as its own endpoint.** miki runs wherever; `MIKI_ROOT` points at the
   box's filesystem (mounted or synced). Same effect.

**Rule of thumb — route through miki when:** the work is real coding (read,
write, edit, run commands, build a feature) and you want the GYM gate, the
kimi-transcript audit, and per-agent isolation. **Use raw `r.sh`/`r2.sh` when:**
the op is not kimi-shaped (infra, daemon, raw shell) and you do not need the
gate.

**The WSS-over-HTTPS lesson carries over.** Just like `r2.sh` is mandatory for
long Dart/Flutter commands, miki's `exec` is a **streaming** tool that MUST ride
WSS (`/ws`) or MCP progress — never block it on a single REST `POST
/tools/call`. A `POST /tools/call` for `exec` is rejected with a "use WSS/MCP"
error on purpose.

---

## Part C — The cloud-agent guideline block (curate + paste into specs)

Copy the section below into every task spec you hand a cloud agent that should
code through miki. It is written for the agent, in the same MANDATORY / STEP
voice as your `AGENTS.md`, so it slots straight in. Edit the `MIKI_*` values per
delegation.

```markdown
## Using miki (inverse kimi — the box's arms)

You are the SURGEON. miki is the robotic arms. You bring the brain; miki
performs each kimi command inside the box. Do NOT SSH the box raw — drive it
through miki.

### STEP 0 — Connect (get your session)
POST to miki with the auth secret. You get a token + your own isolated workspace.

    curl -sk -X POST -H "authorization: Bearer ${MIKI_AUTH_SECRET}" ${MIKI_BASE}/session
    # -> { "ok":true, "token":"<hex>", "sessionId":"<uuid>", "workspace":"<path>" }

Keep that token. Every call below carries it as `Authorization: Bearer <token>`
(REST) or `?token=<token>` (WSS/MCP).

### STEP 1 — (RECOMMENDED) Run the GYM first
Before any real work, prove you can operate. The runner opens a session, you do
the warm-up reps, then the graded exercises; only passing agents get promoted.

    MIKI_AUTH_SECRET=<secret> node gym.mjs

On GATE OPEN the runner calls POST /promote for you. If you mis-fire, drop a
DROP CARD (node drop.mjs) — a discovery, not a failure.

### STEP 2 — Drive the box (the arms)
File tools are REST. Streaming exec is WSS. Both scoped to YOUR workspace.

    # read a file (kimi: Read)
    curl -sk -X POST -H "authorization: Bearer <token>" -H "content-type: application/json" \
      -d '{"tool":"read_file","args":{"path":"<rel>"}}' ${MIKI_BASE}/tools/call

    # write / edit / grep / list_files — same shape, tools: write_file, edit,
    # multiedit, grep, list_files

    # exec (kimi: Bash) — MUST be WSS, streams stdout/stderr/exit like r2.sh:
    #   open WSS ${MIKI_BASE}/ws?token=<token>
    #   send { "type":"start", "command":"cd <repo> && dart test" }
    #   recv { "type":"stdout"|"stderr"|"exit", ... }

If you speak MCP, skip all of the above and connect over MCP-over-SSE:
GET ${MIKI_BASE}/mcp?token=<token> (SSE) -> POST JSON-RPC to the endpoint it
returns. Every miki tool is an MCP tool with its kimi mapping; exec streams as
notification/progress.

### STEP 3 — Skills (optional playbooks)
Load a playbook into yourself, then drive the arms:

    curl -sk -X POST -H "authorization: Bearer <token>" -H "content-type: application/json" \
      -d '{"tool":"skills","args":{"action":"list"}}' ${MIKI_BASE}/tools/call
    curl -sk -X POST -H "authorization: Bearer <token>" -H "content-type: application/json" \
      -d '{"tool":"skills","args":{"action":"get","skill":"read-and-patch"}}' ${MIKI_BASE}/tools/call

### STEP 4 — Audit + ship
GET ${MIKI_BASE}/transcript?session=<sessionId> (Bearer MIKI_AUTH_SECRET) shows
every kimi command your arms performed. Ship your work through the normal box
flow (--ship / PR from inside the box). NEVER download the GitHub PAT locally.

### MANDATORY
- exec is WSS/MCP ONLY. Never block it on REST. (Same as r2.sh for dart test.)
- Stay in YOUR workspace. Tools are sandboxed to your session dir.
- A mis-fire is a DROP CARD, not a retry-loop. node drop.mjs and stop.
```

Set these per delegation:

- `MIKI_BASE` — `https://<box-host>:<port>` where miki listens (the box URL when
  miki runs inside the sandbox).
- `MIKI_AUTH_SECRET` — the secret miki was launched with (you mint it; never
  commit it).

---

## Part D — Forklift-shaped task spec template

Your real specs are: a header (`taskId` / `repo` / `workerType` / `created`) then
a `## Spec` block. Here is that same shape with the miki block appended. Copy it
as the starting point for any task you want coded through miki.

```markdown
# <slug>

- **taskId**: task_xxxxxxxxxxxx_xxxx
- **repo**: arrrrny/<repo>
- **workerType**: agentic
- **created**: 2026-08-20T00:00:00.000000Z

## Spec

<your normal briefing: what to build, the repo, the acceptance, the PR base/branch>

## Using miki (inverse kimi — the box's arms)

You are the SURGEON. miki is the robotic arms. You bring the brain; miki
performs each kimi command inside the box. Do NOT SSH the box raw — drive it
through miki.

### STEP 0 — Connect
POST to miki with the auth secret. You get a token + your own isolated workspace.

    curl -sk -X POST -H "authorization: Bearer ${MIKI_AUTH_SECRET}" ${MIKI_BASE}/session
    # -> { "ok":true, "token":"<hex>", "sessionId":"<uuid>", "workspace":"<path>" }

### STEP 1 — (RECOMMENDED) Run the GYM first
    MIKI_AUTH_SECRET=<secret> node gym.mjs
On GATE OPEN the runner promotes you. Mis-fire -> node drop.mjs.

### STEP 2 — Drive the box
File tools (REST): read_file / write_file / edit / multiedit / grep / list_files
via POST ${MIKI_BASE}/tools/call {"tool":...,"args":...} with Bearer <token>.
exec (kimi: Bash) is WSS ONLY: open ${MIKI_BASE}/ws?token=<token>,
send { "type":"start", "command":"cd <repo> && dart test" }, read stdout/stderr/exit.
Or connect over MCP-over-SSE if you speak MCP.

### STEP 3 — Skills (optional)
POST ${MIKI_BASE}/tools/call {"tool":"skills","args":{"action":"list"|"get","skill":"<name>"}}.

### STEP 4 — Audit + ship
GET ${MIKI_BASE}/transcript?session=<sessionId> (Bearer MIKI_AUTH_SECRET).
Ship via the normal box flow; NEVER download the PAT locally.

### MANDATORY
- exec is WSS/MCP ONLY. Never block on REST.
- Stay in YOUR workspace.
- Mis-fire -> node drop.mjs and stop.
```

---

## Quick reference for you (the orchestrator)

- Launch miki in a box: `npm run bootstrap` (mints `MIKI_AUTH_SECRET`, prints the
  connect URL). Or set `MIKI_AUTH_SECRET` + `MIKI_ROOT` and `npm start`.
- The agent flow you are enabling: `POST /session` -> (GYM -> `POST /promote`) ->
  drive arms (REST/WSS/MCP) -> `GET /transcript` -> ship.
- The audit you get for free: `GET /transcript` lists every kimi command the
  arms performed, per session.
- miki repo: `github.com/arrrrny/miki`. GYM: `github.com/arrrrny/gym`.
  DROP CARD: `github.com/arrrrny/drop-card`.
