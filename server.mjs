#!/usr/bin/env node
// miki — inverse kimi, the Da Vinci arms.
// Cloud agent = surgeon (brings the brain). miki = robotic arms (executes).
// Each tool is a 1:1 mapping to a kimi command, performed inside the box
// exactly as if kimi itself issued it. No model, no API key, no provider.
//
// Transport (mirrors r2.sh: one secure base, REST for files, WSS for exec):
//   REST  (HTTPS)  /            -> health
//                    /tools      -> tool list (with kimi mapping + transport)
//                    /tools/call -> {tool,args} -> {ok,result}  (non-streaming)
//   WSS   (WSS)     /ws          -> streaming exec, frames: stdout/stderr/exit

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import fssync, { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MIKI_PORT || 7654);
const ROOT = path.resolve(process.env.MIKI_ROOT || __dirname);

// Agent sessions & auth (Milestone 3). Each WSS connection carries a token
// issued by POST /session; the token maps to an isolated workspace so
// concurrent cloud agents never collide. AUTH_SECRET gates token issuance.
export const AUTH_SECRET = process.env.MIKI_AUTH_SECRET || 'dev-secret-change-me';
const sessions = new Map(); // token -> { id, workspace }

export async function issueToken() {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  const workspace = path.join(ROOT, '.sessions', id);
  await fs.mkdir(workspace, { recursive: true });
  sessions.set(token, { id, workspace });
  return { token, id, workspace };
}

export function sessionForToken(token) {
  return token ? sessions.get(token) || null : null;
}

// Milestone 4 — kimi-equivalent transcript. Every tool call the arms perform is
// logged as a kimi-style session entry (the auditable record in the box): which
// kimi command was mirrored, by which session, with what args + outcome.
export const transcript = [];

function recordEntry(entry) {
  const full = { ts: new Date().toISOString(), ...entry };
  transcript.push(full);
  return full;
}

// Tool registry. `kimi` = the kimi command this arm mirrors.
// `transport: 'wss'` tools stream frames instead of returning one blob.
export const tools = {
  read_file: {
    kimi: 'Read',
    transport: 'rest',
    description: "Read a UTF-8 text file from the sandbox. Maps to kimi's Read tool.",
    input: { path: 'string — file path relative to ' + ROOT },
    run: async ({ path: rel }, { root }) => {
      if (typeof rel !== 'string' || rel.length === 0) throw new Error('path is required');
      const full = path.resolve(root, rel);
      if (full !== root && !full.startsWith(root + path.sep)) {
        throw new Error('path escapes sandbox root');
      }
      return await fs.readFile(full, 'utf8');
    },
  },
  write_file: {
    kimi: 'Write',
    transport: 'rest',
    description: "Create or overwrite a UTF-8 file in the sandbox. Maps to kimi's Write/Edit tool.",
    input: { path: 'string', content: 'string' },
    run: async ({ path: rel, content }, { root }) => {
      if (typeof rel !== 'string' || rel.length === 0) throw new Error('path is required');
      if (typeof content !== 'string') throw new Error('content is required');
      const full = path.resolve(root, rel);
      if (full !== root && !full.startsWith(root + path.sep)) {
        throw new Error('path escapes sandbox root');
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, 'utf8');
      return `wrote ${rel} (${Buffer.byteLength(content)} bytes)`;
    },
  },
  list_files: {
    kimi: 'Glob',
    transport: 'rest',
    description: "List files in the sandbox (glob). Maps to kimi's Glob tool.",
    input: { pattern: 'string? (default "*", relative to root)' },
    run: async ({ pattern }, { root }) => {
      const pat = typeof pattern === 'string' && pattern.length ? pattern : '*';
      const matches = globSync(pat, { cwd: root }).filter(
        (p) => !p.startsWith('node_modules/') && !p.startsWith('certs/'),
      );
      return matches.sort().join('\n');
    },
  },
  exec: {
    kimi: 'Bash',
    transport: 'wss',
    description: 'Run a command in the box and stream its output. Maps to kimi\'s Bash tool. Use WSS /ws, not REST.',
    input: { command: 'string', cwd: 'string? (relative to root)', timeout: 'number? (seconds)' },
  },
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

// Shared REST handler (served over both plain HTTP and HTTPS).
export async function restHandler(req, res) {
  const url = new URL(req.url, 'https://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    return json(res, 200, {
      name: 'miki',
      tagline: 'inverse kimi — provider-free coding tool server',
      tools: Object.keys(tools),
    });
  }

  if (req.method === 'GET' && url.pathname === '/tools') {
    return json(res, 200, {
      tools: Object.entries(tools).map(([name, t]) => ({
        name,
        kimi: t.kimi,
        transport: t.transport,
        description: t.description,
        input: t.input,
      })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/tools/call') {
    return handleCall(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/session') {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + AUTH_SECRET) {
      return json(res, 401, { ok: false, error: 'unauthorized — expected Bearer <MIKI_AUTH_SECRET>' });
    }
    const { token, id, workspace } = await issueToken();
    return json(res, 200, { ok: true, token, sessionId: id, workspace });
  }

  if (req.method === 'GET' && url.pathname === '/transcript') {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + AUTH_SECRET) {
      return json(res, 401, { ok: false, error: 'unauthorized — expected Bearer <MIKI_AUTH_SECRET>' });
    }
    const sid = url.searchParams.get('session');
    const entries = sid ? transcript.filter((e) => e.sessionId === sid) : transcript;
    return json(res, 200, { ok: true, count: entries.length, entries });
  }

  return json(res, 404, { ok: false, error: 'not found' });
}

// Shared tool invocation — used by REST handler and by the test suite.
export async function invokeTool(name, args = {}, root = ROOT, sessionId = null) {
  const tool = tools[name];
  if (!tool) {
    const out = { ok: false, error: `unknown tool: ${name}` };
    recordEntry({ sessionId, kimi: '?', tool: name, args, transport: 'rest', ...out });
    return out;
  }
  if (tool.transport === 'wss') {
    const out = { ok: false, error: `${name} is a streaming tool — connect over WSS at /ws, not REST` };
    recordEntry({ sessionId, kimi: tool.kimi, tool: name, args, transport: 'rest', ...out });
    return out;
  }
  try {
    const result = await tool.run(args || {}, { root });
    const out = { ok: true, tool: name, result };
    recordEntry({ sessionId, kimi: tool.kimi, tool: name, args, transport: 'wss', ...out });
    return out;
  } catch (e) {
    const out = { ok: false, error: String(e && e.message ? e.message : e) };
    recordEntry({ sessionId, kimi: tool.kimi, tool: name, args, transport: 'wss', ...out });
    return out;
  }
}

async function handleCall(req, res) {
  let data = '';
  for await (const c of req) data += c;
  let body;
  try {
    body = JSON.parse(data || '{}');
  } catch {
    return json(res, 400, { ok: false, error: 'invalid json body' });
  }
  const out = await invokeTool(body.tool, body.args || {});
  const code = out.ok ? 200 : out.error.includes('unknown tool') ? 404 : 400;
  return json(res, code, out);
}

// Unified WSS session — one socket drives every tool. Non-streaming tools
// (read/write/list) reply with a {type:"result",id} frame; exec streams
// stdout/stderr/exit frames. The Da Vinci arms perform each kimi command
// inside the box, driven by the surgeon (agent) over a single connection.
function startExec(ws, msg) {
  const base = ws._session ? ws._session.workspace : ROOT;
  const cwd = msg.cwd ? path.resolve(base, msg.cwd) : base;
  if (cwd !== base && !cwd.startsWith(base + path.sep)) {
    return ws.send(JSON.stringify({ type: 'error', message: 'cwd escapes sandbox root' }));
  }
  const entry = recordEntry({
    sessionId: ws._session ? ws._session.id : null,
    kimi: 'Bash',
    tool: 'exec',
    args: { command: msg.command, cwd: msg.cwd || '' },
    transport: 'wss',
    ok: true,
  });
  const child = spawn(msg.command, { shell: true, cwd, env: { ...process.env, MIKI_ROOT: base } });
  ws._mikiChild = child;
  const timer = msg.timeout
    ? setTimeout(() => {
        child.kill('SIGKILL');
        ws.send(JSON.stringify({ type: 'error', message: `timeout ${msg.timeout}s` }));
      }, msg.timeout * 1000)
    : null;
  child.stdout.on('data', (d) =>
    ws.send(JSON.stringify({ type: 'stdout', data: d.toString('utf8') })),
  );
  child.stderr.on('data', (d) =>
    ws.send(JSON.stringify({ type: 'stderr', data: d.toString('utf8') })),
  );
  child.on('error', (e) =>
    ws.send(JSON.stringify({ type: 'error', message: String(e.message || e) })),
  );
  child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    entry.exitCode = code ?? 0;
    ws.send(JSON.stringify({ type: 'exit', exitCode: code ?? 0 }));
  });
}

function attachWss(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'https://localhost');
    const token = url.searchParams.get('token');
    const session = sessionForToken(token);
    if (!session) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'unauthorized — connect with ?token=<token> (issue one via POST /session)',
        }),
      );
      return ws.close();
    }
    ws._session = session;
    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }));
      }

      if (msg.type === 'start') {
        if (typeof msg.command !== 'string') {
          return ws.send(
            JSON.stringify({ type: 'error', message: 'expected {type:"start",command:"..."}' }),
          );
        }
        return startExec(ws, msg);
      }

      if (msg.type === 'call') {
        if (typeof msg.tool !== 'string') {
          return ws.send(
            JSON.stringify({ type: 'error', message: 'expected {type:"call",tool:"..."}' }),
          );
        }
        return invokeTool(msg.tool, msg.args || {}, ws._session.workspace, ws._session.id).then(
          (out) => ws.send(JSON.stringify({ type: 'result', id: msg.id, ...out })),
        );
      }

      return ws.send(JSON.stringify({ type: 'error', message: `unknown frame type: ${msg.type}` }));
    });
    ws.on('close', () => {
      if (ws._mikiChild) ws._mikiChild.kill();
    });
  });
  return wss;
}

// Build the secure server (REST + WSS on one base). Used by the run-directly
// block and by the test suite (which listens on an ephemeral port).
export function createServer() {
  const tls = {
    key: fssync.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
    cert: fssync.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
  };
  const server = https.createServer(tls, restHandler);
  const wss = attachWss(server);
  return { server, wss };
}

// Run directly -> start the secure server (REST + WSS on one base, like r2.sh).
if (import.meta.url === `file://${process.argv[1]}`) {
  let server;
  try {
    ({ server } = createServer());
  } catch {
    console.error('miki: missing certs/cert.pem + certs/key.pem — run: npm run certs');
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`miki (HTTPS+WSS) listening on https://localhost:${PORT} (root=${ROOT})`);
    console.log(`  REST /tools/call : read_file, write_file, list_files`);
    console.log(`  WSS  /ws          : unified session (call tools + streaming exec)`);
  });
}
