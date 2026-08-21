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
import { attachMcp } from './mcp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MIKI_PORT || 7654);
const ROOT = path.resolve(process.env.MIKI_ROOT || __dirname);

// Agent sessions & auth (Milestone 3). Each WSS connection carries a token
// issued by POST /session; the token maps to an isolated workspace so
// concurrent cloud agents never collide. AUTH_SECRET gates token issuance.
export const AUTH_SECRET = process.env.MIKI_AUTH_SECRET || 'dev-secret-change-me';
const sessions = new Map(); // token -> { id, workspace }
let mcpHandler = null; // assigned by attachMcp when the MCP surface is mounted

// `workspaceArg` lets the delegator anchor a session directly onto an existing
// repo in the box (e.g. /workspace/zorphy) instead of a fresh .sessions scratch
// dir — so the surgeon arms operate on real project files on a real branch.
// Must live inside MIKI_ROOT; pass the repo root (== ROOT) to work in-place.
export async function issueToken(workspaceArg) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  let workspace;
  if (typeof workspaceArg === 'string' && workspaceArg.length) {
    workspace = path.resolve(workspaceArg);
    if (workspace !== ROOT && !workspace.startsWith(ROOT + path.sep)) {
      throw new Error('workspace must be inside MIKI_ROOT');
    }
  } else {
    workspace = path.join(ROOT, '.sessions', id);
  }
  await fs.mkdir(workspace, { recursive: true });
  sessions.set(token, { id, workspace, cleared: false });
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
  grep: {
    kimi: 'Grep',
    transport: 'rest',
    description: "Search file contents in the sandbox by regex. Maps to kimi's Grep tool.",
    input: { pattern: 'string (regex)', path: 'string? (file/dir relative to root, default root)', glob: 'string? (file filter, e.g. "*.ts")' },
    run: async ({ pattern, path: rel, glob }, { root }) => {
      if (typeof pattern !== 'string' || !pattern) throw new Error('pattern is required');
      const base = rel ? path.resolve(root, rel) : root;
      if (base !== root && !base.startsWith(root + path.sep)) throw new Error('path escapes sandbox root');
      const re = new RegExp(pattern);
      const skip = new Set(['node_modules', 'certs', '.sessions']);
      let files = globSync('**/*', { cwd: base, nodir: true }).filter(
        (p) => !p.split('/').some((seg) => skip.has(seg)),
      );
      if (typeof glob === 'string' && glob) {
        const gf = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        files = files.filter((f) => gf.test(f));
      }
      const out = [];
      for (const f of files) {
        const full = path.join(base, f);
        let content;
        try {
          content = await fs.readFile(full, 'utf8');
        } catch {
          continue;
        }
        content.split('\n').forEach((line, i) => {
          if (re.test(line)) out.push(`${f}:${i + 1}:${line}`);
        });
      }
      return out.length ? out.join('\n') : 'no matches';
    },
  },
  edit: {
    kimi: 'Edit',
    transport: 'rest',
    description: "Replace old_string with new_string in a file. Maps to kimi's Edit tool.",
    input: { path: 'string', old_string: 'string', new_string: 'string', replace_all: 'boolean?' },
    run: async ({ path: rel, old_string, new_string, replace_all }, { root }) => {
      if (typeof rel !== 'string' || !rel) throw new Error('path is required');
      if (typeof old_string !== 'string' || typeof new_string !== 'string') {
        throw new Error('old_string and new_string required');
      }
      const full = path.resolve(root, rel);
      if (full !== root && !full.startsWith(root + path.sep)) throw new Error('path escapes sandbox root');
      const content = await fs.readFile(full, 'utf8');
      const count = content.split(old_string).length - 1;
      if (count === 0) throw new Error('old_string not found');
      if (!replace_all && count > 1) {
        throw new Error(`old_string not unique (found ${count}) — pass replace_all or widen it`);
      }
      const next = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
      await fs.writeFile(full, next, 'utf8');
      return `edited ${rel} (${count} occurrence${count === 1 ? '' : 's'})`;
    },
  },
  multiedit: {
    kimi: 'MultiEdit',
    transport: 'rest',
    description: "Apply several edits to one file in order. Maps to kimi's MultiEdit tool.",
    input: { path: 'string', edits: 'array of {old_string,new_string}' },
    run: async ({ path: rel, edits }, { root }) => {
      if (typeof rel !== 'string' || !rel) throw new Error('path is required');
      if (!Array.isArray(edits) || !edits.length) throw new Error('edits array required');
      const full = path.resolve(root, rel);
      if (full !== root && !full.startsWith(root + path.sep)) throw new Error('path escapes sandbox root');
      let content = await fs.readFile(full, 'utf8');
      let done = 0;
      for (const e of edits) {
        if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
          throw new Error('each edit needs old_string + new_string');
        }
        const count = content.split(e.old_string).length - 1;
        if (count === 0) throw new Error('old_string not found: ' + JSON.stringify(e.old_string));
        if (count > 1) throw new Error('old_string not unique: ' + JSON.stringify(e.old_string));
        content = content.replace(e.old_string, e.new_string);
        done++;
      }
      await fs.writeFile(full, content, 'utf8');
      return `multiedit ${rel}: ${done} edits applied`;
    },
  },
  skills: {
    kimi: 'Skill',
    transport: 'rest',
    description: "List or load a skill — a playbook of instructions the surgeon follows inside the box. Maps to kimi's Skill tool, but inverse: the cloud agent loads the skill into itself, then drives the arms. action='list' -> names + descriptions; action='get',skill=NAME -> the SKILL.md body.",
    input: { action: '"list" | "get"', skill: 'string? (name, required when action="get")' },
    run: async ({ action, skill }) => {
      const skillsDir = process.env.MIKI_SKILLS_DIR || path.join(__dirname, 'skills');
      if (action === 'list') {
        const items = [];
        let entries;
        try {
          entries = await fs.readdir(skillsDir, { withFileTypes: true });
        } catch {
          return 'no skills installed';
        }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          let desc = '';
          try {
            const txt = await fs.readFile(path.join(skillsDir, e.name, 'SKILL.md'), 'utf8');
            const fm = /---\n([\s\S]*?)\n---/.exec(txt);
            if (fm) {
              for (const line of fm[1].split('\n')) {
                const m = /^description:\s*(.*)/.exec(line);
                if (m) desc = m[1].trim();
              }
            }
          } catch {
            // no SKILL.md -> still list the name, no description
          }
          items.push({ name: e.name, description: desc });
        }
        if (!items.length) return 'no skills installed';
        return items.map((x) => `${x.name} — ${x.description}`).join('\n');
      }
      if (action === 'get') {
        if (typeof skill !== 'string' || !skill) throw new Error('skill name required when action="get"');
        return await fs.readFile(path.join(skillsDir, skill, 'SKILL.md'), 'utf8');
      }
      throw new Error('action must be "list" or "get"');
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
    return handleCall(req, res, url);
  }

  if (req.method === 'POST' && url.pathname === '/session') {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + AUTH_SECRET) {
      return json(res, 401, { ok: false, error: 'unauthorized — expected Bearer <MIKI_AUTH_SECRET>' });
    }
    let workspace;
    if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
      let data = '';
      for await (const c of req) data += c;
      try {
        const b = JSON.parse(data || '{}');
        workspace = b.workspace;
      } catch {
        // empty/invalid body -> default scratch workspace
      }
    }
    const { token, id, workspace: ws } = await issueToken(workspace);
    recordEntry({ sessionId: id, kimi: 'Session', tool: 'session', args: { workspace: ws }, transport: 'rest', ok: true });
    return json(res, 200, { ok: true, token, sessionId: id, workspace: ws });
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

  if (req.method === 'POST' && url.pathname === '/promote') {
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const token = bearer || url.searchParams.get('token') || '';
    const session = sessionForToken(token);
    if (!session) return json(res, 401, { ok: false, error: 'unknown or missing token' });
    // GATE OPEN -> the surgeon is cleared to operate. The arms are handed over.
    session.cleared = true;
    recordEntry({ sessionId: session.id, kimi: 'Promote', tool: 'promote', args: { token: token.slice(0, 8) + '...' }, transport: 'rest', ok: true });
    return json(res, 200, {
      ok: true,
      cleared: true,
      controlToken: token,
      sessionId: session.id,
      workspace: session.workspace,
      tools: Object.keys(tools),
    });
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const token = bearer || url.searchParams.get('token') || '';
    const session = sessionForToken(token);
    if (!session) return json(res, 401, { ok: false, error: 'unknown or missing token' });
    return json(res, 200, { ok: true, cleared: session.cleared, sessionId: session.id });
  }

  // MCP-over-SSE (Milestone 10). The SSE stream is the server->client channel;
  // JSON-RPC requests arrive as POST /mcp (see mcp.mjs). Only reached when the
  // MCP layer is attached (it patches restHandler).
  if (url.pathname === '/mcp') {
    if (typeof mcpHandler === 'function') return mcpHandler(req, res);
    return json(res, 501, { ok: false, error: 'mcp not attached' });
  }

  return json(res, 404, { ok: false, error: 'not found' });
}

// Shared tool invocation — used by REST, WSS, and MCP. `transport` is the real
// wire that carried the call, so the kimi transcript audit is honest.
export async function invokeTool(name, args = {}, root = ROOT, sessionId = null, transport = 'rest') {
  const tool = tools[name];
  if (!tool) {
    const out = { ok: false, error: `unknown tool: ${name}` };
    recordEntry({ sessionId, kimi: '?', tool: name, args, transport, ...out });
    return out;
  }
  if (tool.transport === 'wss') {
    const out = { ok: false, error: `${name} is a streaming tool — connect over WSS at /ws or MCP, not REST` };
    recordEntry({ sessionId, kimi: tool.kimi, tool: name, args, transport, ...out });
    return out;
  }
  try {
    const result = await tool.run(args || {}, { root });
    const out = { ok: true, tool: name, result };
    recordEntry({ sessionId, kimi: tool.kimi, tool: name, args, transport, ...out });
    return out;
  } catch (e) {
    const out = { ok: false, error: String(e && e.message ? e.message : e) };
    recordEntry({ sessionId, kimi: tool.kimi, tool: name, args, transport, ...out });
    return out;
  }
}

// Streaming exec, shared by WSS and MCP. `onProgress` is called with each
// chunk as it arrives; the returned promise resolves with the full output +
// exit code when the child closes. This is the single source of truth for the
// Bash-mirroring arms — both transports spool the same frames.
export function runExec({ command, root, cwd, timeout, sessionId, onProgress }) {
  const base = root || ROOT;
  const realCwd = cwd ? path.resolve(base, cwd) : base;
  if (realCwd !== base && !realCwd.startsWith(base + path.sep)) {
    const err = 'cwd escapes sandbox root';
    onProgress?.({ type: 'error', message: err });
    return { promise: Promise.resolve({ ok: false, error: err, exitCode: null }), child: null };
  }
  const entry = recordEntry({
    sessionId: sessionId ?? null,
    kimi: 'Bash',
    tool: 'exec',
    args: { command, cwd: cwd || '' },
    transport: 'mcp',
    ok: true,
  });
  const child = spawn(command, { shell: true, cwd: realCwd, env: { ...process.env, MIKI_ROOT: realCwd } });
  const promise = new Promise((resolve) => {
    let out = '';
    const timer = timeout
      ? setTimeout(() => {
          child.kill('SIGKILL');
          onProgress?.({ type: 'error', message: `timeout ${timeout}s` });
        }, timeout * 1000)
      : null;
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      onProgress?.({ type: 'stdout', data: s });
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      onProgress?.({ type: 'stderr', data: s });
    });
    child.on('error', (e) => onProgress?.({ type: 'error', message: String(e.message || e) }));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      entry.exitCode = code ?? 0;
      resolve({ ok: true, result: out, exitCode: code ?? 0 });
    });
  });
  return { promise, child };
}

async function handleCall(req, res, url) {
  let data = '';
  for await (const c of req) data += c;
  let body;
  try {
    body = JSON.parse(data || '{}');
  } catch {
    return json(res, 400, { ok: false, error: 'invalid json body' });
  }
  // Scope REST calls to the agent's session workspace when a token is supplied,
  // so a file written over REST lands in the same box exec runs in (WSS parity).
  // No token -> MIKI_ROOT, preserving the admin/debug behavior.
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = bearer || url.searchParams.get('token') || '';
  const session = sessionForToken(token);
  const root = session ? session.workspace : ROOT;
  const out = await invokeTool(body.tool, body.args || {}, root, session ? session.id : null);
  const code = out.ok ? 200 : out.error.includes('unknown tool') ? 404 : 400;
  return json(res, code, out);
}

// Unified WSS session — one socket drives every tool. Non-streaming tools
// (read/write/list) reply with a {type:"result",id} frame; exec streams
// stdout/stderr/exit frames. The Da Vinci arms perform each kimi command
// inside the box, driven by the surgeon (agent) over a single connection.
function startExec(ws, msg) {
  const base = ws._session ? ws._session.workspace : ROOT;
  const { promise, child } = runExec({
    command: msg.command,
    root: base,
    cwd: msg.cwd,
    timeout: msg.timeout,
    sessionId: ws._session ? ws._session.id : null,
    onProgress: (f) => {
      if (f.type === 'error') ws.send(JSON.stringify({ type: 'error', message: f.message }));
      else if (f.type === 'stdout' || f.type === 'stderr') ws.send(JSON.stringify(f));
      else if (f.type === 'exit') ws.send(JSON.stringify(f));
    },
  });
  ws._mikiChild = child;
  promise.then((r) => {
    if (r.ok) ws.send(JSON.stringify({ type: 'exit', exitCode: r.exitCode }));
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
        return invokeTool(msg.tool, msg.args || {}, ws._session.workspace, ws._session.id, 'wss').then(
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

// Build the secure server (REST + WSS + MCP on one base). Used by the
// run-directly block and by the test suite (which listens on an ephemeral port).
export function createServer() {
  const tls = {
    key: fssync.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
    cert: fssync.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
  };
  const server = https.createServer(tls, restHandler);
  const wss = attachWss(server);
  const mcp = attachMcp(server, { tools, invokeTool, runExec, sessionForToken });
  mcpHandler = mcp.handler;
  return { server, wss, mcp };
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
