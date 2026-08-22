#!/usr/bin/env node
// kimi — the inverse-kimi TELEPORTER. miki is provider-free: the cloud agent
// ITSELF is the provider, and `kimi` is how that agent reaches the sandbox
// without ever cloning the repo to its own machine.
//
// THE PROBLEM THIS KILLS: a cloud agent that downloads the whole repo, edits
// locally, then uploads the diff. That round-trip is slow, lossy, and breaks on
// symlinks / build artifacts. Instead, `kimi` teleports the agent's commands
// straight into the workspace: `kimi s ls` lists the box, `kimi s "cargo check"`
// builds on the box, `kimi s git ...` operates on the box repo. The agent never
// holds the code — it holds a shell into the box.
//
// Credentials are set ONCE, as env (the delegator supplies them — nothing is
// baked in):
//   SSH overlay (preferred — direct, no proxy, no per-call tokens):
//     MIKI_SSH_HOST    box hostname / IP        (e.g. 34.72.35.255)
//     MIKI_SSH_PORT    ssh port                 (default 22)
//     MIKI_SSH_USER    login user               (e.g. agent)
//     MIKI_SSH_KEY     path to ed25519 key  OR
//     MIKI_SSH_KEY_B64 base64 of that key (no file needed)
//   Daytona proxy (fallback — only when SSH is not configured):
//     MIKI_SID       Daytona toolbox session id
//     MIKI_API_KEY   the dtn_ key   -> REST file ops AND the proxy exec WSS
//     MIKI_SSH_TOKEN (optional) the box's native-SSH token, a separate layer
//
// Transports:
//   SSH overlay: one long-lived ssh2 connection in a local daemon (unix socket
//     ~/.kimi_ssh.sock). `kimi s <cmd>` talks to THAT daemon — so the box feels
//     like a local shell: connect once, then every command just works, no
//     per-command handshake. Pure-JS (ssh2), no system ssh binary required.
//   Daytona proxy (fallback): one secure base, the Daytona proxy.
//     WSS  wss://proxy.zuzu.dev/toolbox/<SID>/process/exec/connect  -> streaming exec
//     REST https://proxy.zuzu.dev/toolbox/<SID>/files*              -> read/write/list/delete
//     REST http://localhost:9999 (inside box)                       -> pool task ops
//
// Config resolution (set once, then forget):
//   env MIKI_SSH_*  >  env MIKI_SID/MIKI_API_KEY/MIKI_SSH_TOKEN  >  run/.pool_env

// Zero-dependency for the WSS/REST fallback path (Node 22+ global `WebSocket`,
// no `ws` package needed). The optional SSH overlay adds `ssh2` (pure-JS) — the
// agent runs `node kimi.mjs` with only this file + env vars (+ the ssh2 dep).
import https from 'node:https';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'ssh2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.0';

// When kimi's stdout is piped to `head` / `grep` / a log collector and the
// consumer closes early, writes fail with EPIPE. A shell would just die with
// SIGPIPE; we stop and exit instead of crashing mid-stream.
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); throw e; });
}

// ---------------------------------------------------------------- config
function loadConfig() {
  const tryEnv = (a, b) => process.env[a] || process.env[b] || '';
  let SID = tryEnv('MIKI_SID', 'POOL_SID');
  let AK = tryEnv('MIKI_API_KEY', 'POOL_API_KEY');
  // The proxy's process/exec/connect WSS authenticates with the dtn_ API key
  // (Bearer). The shared SSH/WSS token (MIKI_SSH_TOKEN) is for the box's native
  // SSH layer — a different transport — so it is read if present but optional.
  let TOK = tryEnv('MIKI_SSH_TOKEN', 'R2_SSH_TOKEN');
  if (!SID || !AK) {
    const pe = path.join(__dirname, 'run', '.pool_env');
    if (fs.existsSync(pe)) {
      for (const line of fs.readFileSync(pe, 'utf8').split('\n')) {
        const m = /^export\s+(MIKI_SID|MIKI_API_KEY|POOL_SID|POOL_API_KEY|MIKI_SSH_TOKEN|R2_SSH_TOKEN|MIKI_SSH_HOST|MIKI_SSH_PORT|MIKI_SSH_USER|MIKI_SSH_KEY|MIKI_SSH_KEY_B64)=(.*)$/.exec(line);
        if (m) {
          const v = m[2].replace(/^["']|["']$/g, '');
          if (!process.env[m[1]]) process.env[m[1]] = v;
        }
      }
      SID = SID || tryEnv('MIKI_SID', 'POOL_SID');
      AK = AK || tryEnv('MIKI_API_KEY', 'POOL_API_KEY');
      TOK = TOK || tryEnv('MIKI_SSH_TOKEN', 'R2_SSH_TOKEN');
    }
  }
  // SSH overlay config (set once, like the proxy creds). When present, kimi
  // connects directly to the box over ssh2 and keeps ONE long-lived connection
  // alive in a local daemon — so `kimi s <cmd>` just works after the first
  // connect, no per-command handshake.
  const ssh = {
    host: process.env.MIKI_SSH_HOST || '',
    port: Number(process.env.MIKI_SSH_PORT) || 22,
    user: process.env.MIKI_SSH_USER || '',
    key: process.env.MIKI_SSH_KEY || '',
    keyB64: process.env.MIKI_SSH_KEY_B64 || '',
  };
  const sshOk = !!(ssh.host && ssh.user && (ssh.key || ssh.keyB64));
  if (!sshOk && (!SID || !AK)) {
    console.error('kimi: missing credentials — set the SSH overlay (MIKI_SSH_HOST + MIKI_SSH_USER + MIKI_SSH_KEY or MIKI_SSH_KEY_B64) OR the Daytona proxy (MIKI_SID + MIKI_API_KEY).');
    process.exit(255);
  }
  return { SID, AK, TOK, ssh: sshOk ? ssh : null };
}

const wssBase = (SID) => `wss://proxy.zuzu.dev/toolbox/${SID}/process/exec/connect`;
const restBase = (SID) => `https://proxy.zuzu.dev/toolbox/${SID}`;

// Stable per-agent session id (mirrors r.sh ~/.daytona_session).
function sessionId() {
  const f = path.join(os.homedir(), '.daytona_session');
  try {
    if (!fs.existsSync(f) || !fs.statSync(f).size) {
      const id = `${os.hostname()}-${Date.now()}-${process.pid}`;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, id);
    }
    return fs.readFileSync(f, 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------- REST
function restReq({ method = 'GET', path: p, sid, ak, body, headers = {}, binary = false }) {
  return new Promise((resolve, reject) => {
    const url = new URL(restBase(sid) + p);
    const data = body != null ? (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))) : null;
    const req = https.request(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + ak,
        'User-Agent': UA,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: binary ? buf : buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------- WSS exec (proxy fallback)
// Streams stdout/stderr frames; exits with the remote exit code. This is the
// r2.sh path: one WSS to process/exec/connect, {type:"start"}. The proxy
// authenticates this WSS with the dtn_ API key (Bearer) — the shared SSH token
// is a separate (native-SSH) layer and is not sent here.
function execWss(cfg, { command, cwd, timeout, env }) {
  return new Promise((resolve) => {
    const start = { type: 'start', command };
    if (cwd) start.cwd = cwd;
    if (timeout) start.timeout = timeout;
    if (env) start.env = env;
    // Node's global WebSocket (undici) accepts `headers` as a non-standard
    // constructor option — that is how we send the dtn_ API key (Bearer) on the
    // process/exec/connect upgrade. It is an EventTarget, not an EventEmitter.
    const ws = new WebSocket(wssBase(cfg.SID), {
      headers: { 'User-Agent': UA, Authorization: 'Bearer ' + cfg.AK },
    });
    let done = false;
    const finish = (code) => { if (!done) { done = true; ws.close(); resolve(code); } };
    ws.onopen = () => ws.send(JSON.stringify(start));
    ws.onmessage = (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch { return; }
      if (f.type === 'stdout') process.stdout.write(f.data);
      else if (f.type === 'stderr') process.stderr.write(f.data);
      else if (f.type === 'exit') finish(f.exitCode || 0);
      else if (f.type === 'error') { console.error('\nkimi: remote error:', f.message); finish(2); }
    };
    ws.onerror = (ev) => { console.error('kimi: connection error:', ev.message || ev.error?.message || ev); finish(2); };
  });
}

// ---------------------------------------------------------------- SSH overlay
// Pure-JS ssh2 transport. ONE long-lived ssh2 connection is held by a local
// daemon (unix socket at ~/.kimi_ssh.sock); every `kimi s`/`read`/etc. talks to
// that daemon instead of re-handshaking. This is what makes the box feel like a
// local shell: connect once, then commands just flow. The Daytona WSS/REST
// proxy remains the fallback when only MIKI_SID/MIKI_API_KEY are set.
const DAEMON_SOCK = path.join(os.homedir(), '.kimi_ssh.sock');

function sshAuth(cfg) {
  const a = { host: cfg.ssh.host, port: cfg.ssh.port, username: cfg.ssh.user };
  if (cfg.ssh.keyB64) a.privateKey = Buffer.from(cfg.ssh.keyB64, 'base64');
  else a.privateKey = fs.readFileSync(cfg.ssh.key);
  return a;
}

// Length-prefixed JSON frame (4-byte BE length + payload) so binary stdout
// frames survive intact even when they contain newlines.
function sendFrame(sock, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(b.length, 0);
  const frame = Buffer.concat([head, b]);
  if (!Buffer.isBuffer(frame)) throw new Error('sendFrame: frame is not a Buffer');
  sock.write(frame);
}

// Detect whether we are already running on the target box. In that case,
// `boxExec` should run the command locally instead of trying to self-SSH
// (which breaks inside non-interactive remote exec channels).
const BOX_HOSTNAME = os.hostname();
function isLocalBox(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  return h === BOX_HOSTNAME.toLowerCase();
}

// Drain length-prefixed frames from a socket; calls onMsg for each parsed frame.
// Returns the leftover buffer for the next chunk.
function drainFrames(buf, onMsg) {
  while (buf.length >= 4) {
    const len = buf.readUInt32BE(0);
    if (buf.length < 4 + len) break;
    let f;
    try { f = JSON.parse(buf.slice(4, 4 + len).toString('utf8')); } catch { buf = buf.slice(4 + len); continue; }
    buf = buf.slice(4 + len);
    onMsg(f);
  }
  return buf;
}

// --- daemon side: holds the connection, serves exec/sftp over the socket ---
function startSshDaemon() {
  try { fs.unlinkSync(DAEMON_SOCK); } catch { /* may not exist */ }
  const cfg = loadConfig();
  const client = new Client();
  // Start accepting client connections only AFTER the SSH link is ready, so
  // exec/sftp requests never race the handshake.
  client.on('ready', () => {
    console.error('kimi-daemon: ssh ready');
    const server = net.createServer((conn) => {
      let buf = Buffer.alloc(0);
      conn.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        buf = drainFrames(buf, (msg) => handleDaemon(client, conn, msg));
      });
      conn.on('error', () => { try { conn.destroy(); } catch {} });
    });
    server.on('error', (e) => console.error('kimi-daemon: server error', e.message));
    server.listen(DAEMON_SOCK, () => console.error('kimi-daemon: listening on', DAEMON_SOCK));
  });
  client.on('error', (e) => { console.error('kimi-daemon: ssh error', e.message); process.exit(1); });
  client.on('close', () => process.exit(0));
  client.connect(sshAuth(cfg));
  // 'stop' control frame from `kimi --ssh-stop`.
  // (handled in handleDaemon)
}

function handleDaemon(client, conn, msg) {
  if (msg.type === 'stop') { process.exit(0); return; }
  if (msg.type === 'ping') { sendFrame(conn, { type: 'pong' }); return; }
  if (msg.type === 'exec') {
    const cmd = msg.cwd ? `cd ${JSON.stringify(msg.cwd)} && ${msg.command}` : msg.command;
    client.exec(cmd, { pty: false }, (err, stream) => {
      if (err) { sendFrame(conn, { type: 'error', message: err.message }); sendFrame(conn, { type: 'exit', code: 2 }); return; }
      stream.on('data', (d) => sendFrame(conn, { type: 'stdout', data: d.toString('base64') }));
      stream.stderr.on('data', (d) => sendFrame(conn, { type: 'stderr', data: d.toString('base64') }));
      stream.on('close', (code) => sendFrame(conn, { type: 'exit', code: code ?? 0 }));
    });
    return;
  }
  if (msg.type === 'sftp') {
    client.sftp((err, sftp) => {
      if (err) { sendFrame(conn, { type: 'error', message: err.message }); sendFrame(conn, { type: 'result', code: 2 }); return; }
      const fail = (e) => { sendFrame(conn, { type: 'error', message: e.message }); sendFrame(conn, { type: 'result', code: 2 }); };
      if (msg.op === 'read') {
        sftp.readFile(msg.path, (e, d) => { if (e) return fail(e); sendFrame(conn, { type: 'data', data: d.toString('base64') }); sendFrame(conn, { type: 'result', code: 0 }); });
      } else if (msg.op === 'write') {
        sftp.writeFile(msg.path, Buffer.from(msg.content || '', 'utf8'), (e) => { if (e) return fail(e); sendFrame(conn, { type: 'result', code: 0 }); });
      } else if (msg.op === 'list') {
        sftp.readdir(msg.path || '/workspace', (e, list) => {
          if (e) return fail(e);
          sendFrame(conn, { type: 'items', items: list.map((f) => ({ name: f.filename, isDir: !!(f.longname && f.longname[0] === 'd'), size: f.attrs.size, mtime: f.attrs.mtime })) });
          sendFrame(conn, { type: 'result', code: 0 });
        });
      } else if (msg.op === 'delete') {
        sftp.unlink(msg.path, (e) => { if (e) return fail(e); sendFrame(conn, { type: 'result', code: 0 }); });
      } else {
        sendFrame(conn, { type: 'result', code: 2 });
      }
    });
    return;
  }
}

// --- client side: ensure the daemon is up, then talk to it ---
function spawnDaemon() {
  return new Promise((resolve) => {
    try { fs.unlinkSync(DAEMON_SOCK); } catch { /* best-effort */ }
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--ssh-daemon'], {
      env: process.env,
      stdio: ['ignore', fs.openSync(path.join(os.homedir(), '.kimi_ssh_daemon.log'), 'a'), fs.openSync(path.join(os.homedir(), '.kimi_ssh_daemon.log'), 'a')],
    });
    const t0 = Date.now();
    const poll = () => {
      if (fs.existsSync(DAEMON_SOCK)) {
        const c = net.connect(DAEMON_SOCK);
        c.on('connect', () => { try { c.end(); } catch {} resolve(); });
        c.on('error', () => { if (Date.now() - t0 > 5000) resolve(); else setTimeout(poll, 150); });
      } else if (Date.now() - t0 > 5000) {
        resolve();
      } else {
        setTimeout(poll, 150);
      }
    };
    setTimeout(poll, 200);
  });
}

function ensureDaemon() {
  return new Promise((resolve) => {
    if (!fs.existsSync(DAEMON_SOCK)) return spawnDaemon().then(resolve);
    const c = net.connect(DAEMON_SOCK);
    let done = false;
    const give = () => { if (!done) { done = true; try { c.destroy(); } catch {} resolve(); } };
    c.setTimeout(800);
    c.on('connect', () => sendFrame(c, { type: 'ping' }));
    c.on('data', (d) => drainFrames(d, (f) => { if (f.type === 'pong') give(); }));
    c.on('timeout', () => { try { c.destroy(); } catch {} try { fs.unlinkSync(DAEMON_SOCK); } catch {} spawnDaemon().then(resolve); });
    c.on('error', () => { try { c.destroy(); } catch {} try { fs.unlinkSync(DAEMON_SOCK); } catch {} spawnDaemon().then(resolve); });
  });
}

// Stream a command/list/file over the daemon. Streams stdout/stderr to the
// local terminal; resolves with the remote exit/result code.
function sshCall(msg, { capture = false } = {}) {
  return new Promise((resolve) => {
    const c = net.connect(DAEMON_SOCK);
    let buf = Buffer.alloc(0);
    let done = false;
    let captured = '';
    let timer;
    if (msg.timeout) timer = setTimeout(() => { console.error(`\nkimi: ssh timeout ${msg.timeout}s`); finish(124); }, msg.timeout * 1000);
    const finish = (code) => { if (!done) { done = true; if (timer) clearTimeout(timer); try { c.end(); } catch {} resolve(capture ? { code: code ?? 0, out: captured } : (code ?? 0)); } };
    c.on('connect', () => sendFrame(c, msg));
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      buf = drainFrames(buf, (f) => {
        if (f.type === 'stdout') { const s = Buffer.from(f.data, 'base64'); if (capture) captured += s.toString('utf8'); else process.stdout.write(s); }
        else if (f.type === 'stderr') process.stderr.write(Buffer.from(f.data, 'base64'));
        else if (f.type === 'data') process.stdout.write(Buffer.from(f.data, 'base64'));
        else if (f.type === 'items') { for (const it of f.items) console.log((it.isDir ? 'd' : '-') + ' ' + String(it.size || 0).padStart(12) + ' ' + new Date((it.mtime || 0) * 1000).toISOString().slice(0, 19) + ' ' + it.name); }
        else if (f.type === 'exit' || f.type === 'result') finish(f.code);
        else if (f.type === 'error') console.error('kimi: ' + (f.message || 'ssh error'));
      });
    });
    c.on('error', () => { console.error('kimi: ssh daemon unreachable — is MIKI_SSH_* set and `kimi --ssh-stop` not stale?'); finish(2); });
  });
}

// ---------------------------------------------------------------- GitHub issue fetch (runs on the box)
// Fetches issue data via curl from the GCP box.
// Uses GITHUB_TOKEN/GH_TOKEN from the box environment if set.
async function fetchIssue(owner, repo, number) {
  // curl-based fetch that works without gh auth
  // Uses GH_TOKEN/GITHUB_TOKEN if set, otherwise unauthenticated (rate limited)
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const authHeader = token ? `-H "Authorization: Bearer ${token}"` : '';
  const cmd = `curl -s ${authHeader} -H "Accept: application/vnd.github.v3+json" https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
  return boxExec({ ssh: { host: 'localhost', port: 2222, user: 'agent', key: '~/.ssh/agent_key' } }, cmd, { timeout: 30 });
}
// Box exec that prepends the same shell bootstrap r.sh/r2.sh use, so PATH,
// DAYTONA_SESSION and ~/.bash_env are loaded for non-interactive commands.
// We also source the cargo env and put the standard toolchain dirs on PATH so
// a cloud agent can `cargo`/`dart`/`flutter` straight away — r.sh/r2.sh share
// the same minimal bootstrap and would otherwise lose cargo/dart on PATH.
function boxExec(cfg, command, { cwd, timeout, capture = false } = {}) {
  const wrapped =
    `export DAYTONA_SESSION='${sessionId()}'; ` +
    `source ~/.bash_env 2>/dev/null; ` +
    `source "$HOME/.cargo/env" 2>/dev/null; ` +
    `export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/dart-sdk/bin:/opt/flutter/bin:/usr/local/bin:/workspace:$PATH"; ` +
    `${command}`;
  // When running on the box itself (common for the cloud-agent path: agent
  // SSHes into the box and runs kimi there), skip the SSH overlay and run
  // the command locally. This avoids the non-interactive exec daemon problem
  // and keeps the same wrapped bootstrap as the remote path.
  if (cfg.ssh && isLocalBox(cfg.ssh.host)) {
    return execLocal(wrapped, { cwd, timeout, capture });
  }
  if (cfg.ssh) return ensureDaemon().then(() => sshCall({ type: 'exec', command: wrapped, cwd, timeout }, { capture }));
  return execWss(cfg, { command: wrapped, cwd, timeout });
}

function execLocal(command, { cwd, timeout, capture = false } = {}) {
  return new Promise((resolve) => {
    const opts = cwd ? { cwd } : {};
    const child = spawn('bash', ['-lc', command], opts);
    let captured = '';
    let timer;
    if (timeout) timer = setTimeout(() => { console.error(`\nkimi: local timeout ${timeout}s`); child.kill('SIGKILL'); }, timeout * 1000);
    child.stdout.on('data', (d) => { if (capture) captured += d; else process.stdout.write(d); });
    child.stderr.on('data', (d) => { if (capture) captured += d; else process.stderr.write(d); });
    child.on('exit', (code) => { if (timer) clearTimeout(timer); resolve(capture ? { code: code ?? 0, out: captured } : (code ?? 0)); });
    child.on('error', (e) => { console.error('kimi: local exec error:', e.message); if (timer) clearTimeout(timer); resolve(capture ? { code: 2, out: '' } : 2); });
  });
}

// ---------------------------------------------------------------- teleporter
// `kimi s <cmd>` runs <cmd> INSIDE the workspace. The agent never
// downloads the repo — it holds a shell into the box. cwd is persisted (in
// ~/.kimi_teleport) so `kimi s cd /workspace/herdr` then `kimi s ls` behaves
// like one continuous session. This is the whole point: kill the
// download-edit-upload round-trip that wastes an agent's time and breaks on
// symlinks / build artifacts.
const STATE_FILE = path.join(os.homedir(), '.kimi_teleport');
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* corrupt state — fall through */ }
  return { cwd: '/workspace' };
}
function saveState(s) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch { /* best-effort */ }
}

async function teleport(cfg, args) {
  const state = loadState();
  if (args.length === 0) { console.log(state.cwd); return 0; }
  const cmd = args.join(' ');
  // `cd` only moves the persisted cwd; it does not spawn a remote shell.
  // Treat as a cd ONLY when it is exactly `cd` or `cd <one-path-token>` with
  // no trailing shell operators — so `cd /x && grep ...` is NOT swallowed as
  // a directory change (that corrupted the persisted cwd and broke everything
  // after it). Compound commands run as a normal box exec instead.
  const cdMatch = /^cd(?:\s+(\S+))?\s*$/.exec(cmd);
  if (cdMatch) {
    const target = cdMatch[1] || '/workspace';
    state.cwd = path.resolve(state.cwd, target);
    saveState(state);
    return 0;
  }
  return boxExec(cfg, cmd, { cwd: state.cwd });
}

// ---------------------------------------------------------------- file ops
// In the SSH overlay, SFTP paths are absolute on the box. Match the REST
// behavior by resolving relative paths against /workspace so `kimi read
// package.json` works the same way over both transports.
function resolveSshPath(p) {
  if (!p) return '/workspace';
  return path.isAbsolute(p) ? p : path.join('/workspace', p);
}

async function readFile(cfg, p) {
  if (cfg.ssh) { await ensureDaemon(); return sshCall({ type: 'sftp', op: 'read', path: resolveSshPath(p) }); }
  const r = await restReq({ path: '/files/download?path=' + encodeURIComponent(p), sid: cfg.SID, ak: cfg.AK, binary: true });
  if (r.status >= 400) { console.error('kimi: read failed', r.status, r.body.slice(0, 120)); return 2; }
  process.stdout.write(r.body);
  return 0;
}

async function saveFile(cfg, p, local) {
  if (cfg.ssh) {
    await ensureDaemon();
    const { code, out } = await sshCall({ type: 'exec', command: `base64 -w0 ${JSON.stringify(resolveSshPath(p))} 2>/dev/null || true`, capture: true });
    if (code !== 0) { console.error('kimi: download failed'); return 2; }
    fs.writeFileSync(local, Buffer.from(out.replace(/\s+/g, ''), 'base64'));
    console.log(`kimi: saved ${p} -> ${local} (${out.length} B)`);
    return 0;
  }
  const r = await restReq({ path: '/files/download?path=' + encodeURIComponent(p), sid: cfg.SID, ak: cfg.AK, binary: true });
  if (r.status >= 400) { console.error('kimi: download failed', r.status); return 2; }
  fs.writeFileSync(local, r.body);
  console.log(`kimi: saved ${p} -> ${local} (${r.body.length} B)`);
  return 0;
}

async function writeContent(cfg, p, content) {
  if (cfg.ssh) {
    await ensureDaemon();
    const code = await sshCall({ type: 'sftp', op: 'write', path: resolveSshPath(p), content });
    console.log(code === 0 ? `Written to ${p}` : 'kimi: write failed');
    return code === 0 ? 0 : 2;
  }
  const boundary = '----kimi' + Date.now();
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, Buffer.from(content, 'utf8'), tail]);
  const r = await restReq({
    method: 'POST',
    path: '/files/upload?path=' + encodeURIComponent(p),
    sid: cfg.SID, ak: cfg.AK, body,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
  if (r.status >= 400) { console.error('kimi: write failed', r.status, r.body.slice(0, 120)); return 2; }
  console.log('Written to', p);
  return 0;
}

async function uploadFile(cfg, p, local) {
  return writeContent(cfg, p, fs.readFileSync(local));
}

async function listDir(cfg, p) {
  if (cfg.ssh) { await ensureDaemon(); return sshCall({ type: 'sftp', op: 'list', path: resolveSshPath(p) }); }
  const r = await restReq({ path: '/files?path=' + encodeURIComponent(p || '/workspace'), sid: cfg.SID, ak: cfg.AK });
  if (r.status >= 400) { console.error('kimi: list failed', r.status); return 2; }
  let items;
  try { items = JSON.parse(r.body); } catch { console.error('kimi: bad list response'); return 2; }
  for (const f of items) {
    const kind = f.isDir ? 'd' : '-';
    console.log(kind + ' ' + String(f.size || 0).padStart(12) + ' ' + (f.modifiedAt || '').slice(0, 19) + ' ' + f.name);
  }
  return 0;
}

async function deleteFile(cfg, p) {
  if (cfg.ssh) { await ensureDaemon(); const code = await sshCall({ type: 'sftp', op: 'delete', path: resolveSshPath(p) }); console.log(code === 0 ? `Deleted ${p}` : 'kimi: delete failed'); return code === 0 ? 0 : 2; }
  const r = await restReq({ method: 'DELETE', path: '/files?path=' + encodeURIComponent(p), sid: cfg.SID, ak: cfg.AK });
  if (r.status >= 400) { console.error('kimi: delete failed', r.status); return 2; }
  console.log('Deleted', p);
  return 0;
}

async function check(cfg) {
  if (cfg.ssh) {
    await ensureDaemon();
    const code = await sshCall({ type: 'exec', command: 'echo SSH_OK' });
    console.log(code === 0 ? 'SSH: OK' : 'SSH: FAIL');
    return code === 0 ? 0 : 2;
  }
  const r = await restReq({ path: '/files?path=/workspace', sid: cfg.SID, ak: cfg.AK });
  if (r.body.trim().startsWith('[{')) { console.log('REST: OK'); return 0; }
  console.log('REST: FAIL —', r.body.slice(0, 120));
  return 2;
}

// ---------------------------------------------------------------- pool ops
// Task lifecycle (claim/complete/update) hits the pool at localhost:9999 INSIDE
// the box — exactly what r.sh --claim does after pool.sh --ensure. We run the
// curl there via box exec rather than shelling out to the old r.sh.
function poolOp(cfg, method, taskPath, body) {
  const json = body ? JSON.stringify(body).replace(/'/g, "'\\''") : '{}';
  const cmd = `bash /workspace/pool.sh --ensure >/dev/null 2>&1; curl -s -m 30 -X ${method} http://localhost:9999${taskPath} -H 'Content-Type: application/json' -d '${json}'`;
  return boxExec(cfg, cmd, { timeout: 60 });
}

function shipCmd(cfg, args) {
  const remote = `bash /workspace/ship.sh ${args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ')}`;
  return boxExec(cfg, remote, { timeout: 300 });
}

// ---------------------------------------------------------------- in-box miki
// Optional: if the box runs miki's in-box server (server.mjs) on :7654, the
// agent can call its structured, sandbox-safe tools through the proxy too.
// `kimi serve` boots it; `kimi session`/`kimi tool` drive it. This is how an
// agent gets miki's read/grep/edit/exec arms instead of raw shell.
function mikiServe(cfg) {
  const cmd = [
    "fuser -k 7654/tcp 2>/dev/null; sleep 1",
    "cd /workspace/miki && MIKI_ROOT=/workspace setsid node /workspace/miki/server.mjs >/workspace/miki_serve.log 2>&1 </dev/null & disown",
    "sleep 2; for i in $(seq 1 30); do c=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 https://localhost:7654/ 2>/dev/null); [ \"$c\" = '200' ] && break; sleep 0.5; done; echo \"miki_health=$c\"",
  ].join('; ');
  return boxExec(cfg, cmd, { timeout: 60 });
}

function mikiSession(cfg, workspace) {
  const body = workspace ? JSON.stringify({ workspace }) : '{}';
  const cmd = `curl -sk -X POST https://localhost:7654/session -H 'Authorization: Bearer dev-secret-change-me' -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`;
  return boxExec(cfg, cmd, { timeout: 30 });
}

function mikiTool(cfg, name, argsJson, workspace) {
  let args;
  try { args = JSON.parse(argsJson || '{}'); } catch { args = {}; }
  const sbody = JSON.stringify({ workspace: workspace || '/workspace' });
  const tbody = JSON.stringify({ tool: name, args });
  // Create a session (anchored to `workspace`), grab its token, then call the
  // tool with ?token= so miki scopes file paths to that session's workspace.
  const cmd =
    `TOK=$(curl -sk -X POST https://localhost:7654/session -H 'Authorization: Bearer dev-secret-change-me' ` +
    `-H 'Content-Type: application/json' -d '${sbody.replace(/'/g, "'\\''")}' ` +
    `| python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'); ` +
    `curl -sk -X POST "https://localhost:7654/tools/call?token=$TOK" ` +
    `-H 'Content-Type: application/json' ` +
    `-d '${tbody.replace(/'/g, "'\\''")}'`;
  return boxExec(cfg, cmd, { timeout: 120 });
}

// ---------------------------------------------------------------- CLI
function usage() {
  console.log(`kimi — the inverse-kimi teleporter (miki)

  THE TELEPORTER — your commands run INSIDE the workspace.
  The agent never clones the repo; it holds a shell into the box. cwd is
  persisted, so 'kimi s cd <dir>' then 'kimi s <cmd>' is one continuous session.
    kimi s <cmd...>                              run <cmd> on the box (e.g. 'kimi s ls')
    kimi s cd <dir>                              change the persisted box cwd
    kimi s                                       print the current box cwd

  SSH OVERLAY (preferred) — set once, then 'kimi s' just works:
    MIKI_SSH_HOST / MIKI_SSH_PORT / MIKI_SSH_USER
    MIKI_SSH_KEY (path) or MIKI_SSH_KEY_B64 (inline base64)
    kimi --ssh-stop                              kill the local ssh daemon
  (Daytona proxy is the fallback when only MIKI_SID/MIKI_API_KEY are set.)

  FILE OPS (SSH: sftp; proxy: REST, against the box)
    kimi read  <remote>          [-o <local>]    download file
    kimi write <remote> <content>                 write file from args
    kimi upload <remote> <local>                  upload local file (binary-safe)
    kimi list  <dir>                             list directory
    kimi delete <remote>                         delete file

  POOL TASK LIFECYCLE (claim / update / complete / ship)
    kimi claim  <taskId> [--model m]
    kimi complete <taskId> <prUrl|msg>
    kimi update <taskId> <msg>
    kimi ship [--dry-run] <repo> <branch> "title" [issue] [body]

  IN-BOX MIKI (optional structured tools)
    kimi serve                                   boot in-box miki server (:7654)
    kimi session [<workspace>]                    create miki session token
    kimi tool <name> '<json-args>' [--workspace <ws>]

  kimi check                                   connectivity check
  kimi exec <cmd...> [-d <dir>] [-t <secs>]     one-shot streaming exec (r2.sh parity)
  kimi speckit <phase|args...> [-d <dir>] [-t <secs>]  run SDD on the box: phases specify|plan|tasks|implement (skills) or any specify subcommand
    kimi speckit specify "<desc>"             write spec + auto-spawn its worktree (worktrees.create hook)
    kimi speckit worktrees.create <branch>    spawn an isolated git worktree for a feature branch
    kimi speckit worktrees.list               dashboard of active worktrees
    kimi speckit worktrees.clean             prune/remove merged or stale worktrees
  kimi goal "<objective>" [-d <dir>]                write a durable GOAL.md contract on the box (kimi /goal mirror); kimi goal prints it
  kimi issue <owner/repo#number|url>            fetch GitHub issue JSON (uses GITHUB_TOKEN if set)`);
}

async function main() {
  const cfg = loadConfig();
  const argv = process.argv.slice(2);
  const [sub, ...rest] = argv;
  const has = (f) => argv.includes(f);
  const valAfter = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

  // `kimi speckit-<cmd> [args...]` mirrors ANY specify subcommand straight to
  // the box (init / check / version / self / extension / integration / event /
  // preset / bundle / workflow / ...). This wires the rest of the specify
  // surface as first-class kimi commands; `kimi speckit <args>` remains the raw
  // passthrough and `kimi speckit <phase>` runs the SDD cycle phases. Honors
  // the persisted `kimi s cd <dir>` cwd; -d/-t override it.
  if (sub && sub.startsWith('speckit-')) {
    const cmd = sub.slice('speckit-'.length);
    let cwd, timeout;
    const cmdArgs = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-d') cwd = rest[++i];
      else if (rest[i] === '-t') timeout = Number(rest[++i]);
      else cmdArgs.push(rest[i]);
    }
    const state = loadState();
    return boxExec(cfg, `specify ${cmd} ${cmdArgs.join(' ')}`.trim(), { cwd: cwd || state.cwd, timeout: timeout || 600 });
  }

  switch (sub) {
    case 'check': return check(cfg);
    case 's': return teleport(cfg, rest);
    case 'read': case '-s': {
      const out = valAfter('-o');
      return out ? saveFile(cfg, rest[0], out) : readFile(cfg, rest[0]);
    }
    case 'write': case '-w': return writeContent(cfg, rest[0], rest.slice(1).join(' '));
    case 'upload': case '-W': return uploadFile(cfg, rest[0], rest[1]);
    case 'list': case '-l': return listDir(cfg, rest[0]);
    case 'delete': case '-delf': return deleteFile(cfg, rest[0]);
    case 'claim': {
      const model = valAfter('--model') || 'kimi';
      return poolOp(cfg, 'POST', `/tasks/${rest[0]}/claim`, { model });
    }
    case 'complete': {
      const v = rest[1] || '';
      const body = v.startsWith('http') ? { prUrl: v }
        : v.endsWith('.patch') ? { patchPath: v }
        : v.includes('.tar') ? { tarballPath: v }
        : { errorMessage: v };
      return poolOp(cfg, 'POST', `/tasks/${rest[0]}/complete`, body);
    }
    case 'update': return poolOp(cfg, 'POST', `/tasks/${rest[0]}/update`, { message: rest.slice(1).join(' ') });
    case 'ship': return shipCmd(cfg, rest);
    case 'serve': return mikiServe(cfg);
    case 'session': return mikiSession(cfg, rest[0]);
    case 'tool': {
      let ws, dir;
      const targs = [];
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--workspace') ws = argv[++i];
        else if (argv[i] === '-d') dir = argv[++i];
        else targs.push(argv[i]);
      }
      return mikiTool(cfg, targs[0], targs[1], ws || dir);
    }
    case 'exec': {
      // Parse -d <dir> (cwd) and -t <secs> (timeout); rest is the command.
      let cwd, timeout;
      const cmdArgs = [];
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '-d') cwd = argv[++i];
        else if (argv[i] === '-t') timeout = Number(argv[++i]);
        else cmdArgs.push(argv[i]);
      }
      return boxExec(cfg, cmdArgs.join(' '), { cwd, timeout });
    }
    case 'speckit': {
      // Spec-driven development through kimi's teleporter. The agent never
      // holds the repo; SDD runs ON THE BOX. Three modes:
      //   • SDD cycle phases (skills): `kimi speckit specify|plan|tasks|implement`
      //     each phase's real work is a bash script in
      //     <project>/.specify/scripts/bash/ — kimi runs it in the persisted cwd.
      //       specify -> create-new-feature.sh  (writes spec.md)
      //       plan    -> setup-plan.sh          (writes plan.md)
      //       tasks   -> setup-tasks.sh         (writes tasks.md)
      //       implement -> no single script; surface the implement skill so the
      //                    agent can follow it and write the code on the box.
      //   • worktree skills (spec-kit-worktree-parallel extension): isolate each
      //     feature in its own git worktree so multiple agents run in parallel
      //     without clobbering the primary tree. `kimi speckit specify` mirrors
      //     the extension's `after_specify -> speckit.worktrees.create` hook: it
      //     auto-spawns a worktree for the new feature branch right after writing
      //     the spec (the raw bash passthrough would otherwise skip the hook).
      //       worktrees.create <branch> [--in-place] [--base-ref X]
      //       worktrees.list
      //       worktrees.clean
      //   • raw passthrough: anything else (`kimi speckit init|check|workflow …`)
      //     runs `specify <args>` on the box.
      // Honors the persisted `kimi s cd <dir>` cwd so
      // `kimi s cd /workspace/forklift && kimi speckit specify "..."` is one
      // continuous session. -d <dir> overrides the cwd; -t <secs> sets timeout.
      let cwd, timeout;
      const cmdArgs = [];
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '-d') cwd = argv[++i];
        else if (argv[i] === '-t') timeout = Number(argv[++i]);
        else cmdArgs.push(argv[i]);
      }
      const state = loadState();
      const phase = cmdArgs[0];
      const sdd = { specify: 'create-new-feature.sh', plan: 'setup-plan.sh', tasks: 'setup-tasks.sh' };
      const WT_SCRIPT = '.specify/extensions/worktrees/scripts/bash/create-worktree.sh';
      // Resolve the git repo root so the relative .specify/... script paths
      // resolve even when the agent hasn't cd'd into the repo yet (fresh box,
      // no persisted cwd) — that's what produced "Script not present" before.
      // Falls back to the box's primary repo when no cwd is known yet.
      const repoCwd = cwd || state.cwd || '/workspace/kimi-code-sync';
      const repoCd = `cd "$(G=$(git -C "${repoCwd}" rev-parse --show-toplevel 2>/dev/null); if [ -n "$G" ]; then echo "$G"; else git -C /workspace/kimi-code-sync rev-parse --show-toplevel 2>/dev/null || echo "${repoCwd}"; fi)"`;

      // --- worktree skills (spec-kit-worktree-parallel) ---
      if (phase === 'worktrees.create') {
        const wtArgs = cmdArgs.slice(1).map((a) => JSON.stringify(a)).join(' ');
        return boxExec(cfg, `${repoCd} && bash ${WT_SCRIPT} --json ${wtArgs}`.trim(), { cwd: repoCwd, timeout: timeout || 120 });
      }
      if (phase === 'worktrees.list') {
        return boxExec(cfg, `${repoCd} && git worktree list`, { cwd: repoCwd, timeout: timeout || 60 });
      }
      if (phase === 'worktrees.clean') {
        return boxExec(cfg, `${repoCd} && git worktree prune && git worktree list`, { cwd: repoCwd, timeout: timeout || 120 });
      }

      if (phase && sdd[phase]) {
        const scriptArgs = cmdArgs.slice(1).map((a) => JSON.stringify(a)).join(' ');
        const run = `${repoCd} && bash .specify/scripts/bash/${sdd[phase]} ${scriptArgs}`.trim();
        // After `specify`, mirror the extension's after_specify hook: spawn a
        // worktree for the feature branch the spec just created (the newest
        // entry under specs/), so all follow-up SDD work happens in isolation.
        // The spec folder itself is generated by specify — never hand-created.
        if (phase === 'specify') {
          const rc1 = await boxExec(cfg, run, { cwd: repoCwd, timeout: timeout || 600 });
          if (rc1 !== 0) return rc1;
          const { code, out } = await boxExec(cfg, `${repoCd} && ls -1 specs 2>/dev/null | sort | tail -1`, { cwd: repoCwd, timeout: 60, capture: true });
          const branch = (out || '').toString().trim().split('\n').pop();
          if (!branch) return 0;
          return boxExec(cfg, `${repoCd} && bash ${WT_SCRIPT} --json ${JSON.stringify(branch)}`.trim(), { cwd: repoCwd, timeout: 120 });
        }
        return boxExec(cfg, run, { cwd: repoCwd, timeout: timeout || 600 });
      }
      if (phase === 'implement') {
        return boxExec(cfg, `${repoCd} && cat .kimi-code/skills/speckit-implement/SKILL.md 2>/dev/null || cat .specify/skills/speckit-implement/SKILL.md 2>/dev/null || echo "follow the speckit-implement skill"`, { cwd: repoCwd, timeout: timeout || 120 });
      }
      return boxExec(cfg, `${repoCd} && specify ${cmdArgs.join(' ')}`.trim(), { cwd: repoCwd, timeout: timeout || 600 });
    }
    case 'goal': {
      // `kimi goal "<objective>"` writes a durable goal artifact (GOAL.md) onto
      // the box, in the persisted cwd — a completion contract the agent pursues
      // across turns. This is the teleporter's mirror of kimi-code's /goal: the
      // agent never holds the repo, so the goal lives with the code on the box.
      // `kimi goal` (no args) prints the current goal. The objective is base64'd
      // so any text (quotes, backticks, newlines) lands in the file verbatim.
      // Honors -d <dir> to choose the cwd.
      let cwd;
      const goalArgs = [];
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '-d') cwd = argv[++i];
        else goalArgs.push(argv[i]);
      }
      const state = loadState();
      const goalCwd = cwd || state.cwd;
      if (goalArgs.length === 0) {
        return boxExec(cfg, 'cat GOAL.md 2>/dev/null || echo kimi: no goal set - run: kimi goal with your objective', { cwd: goalCwd });
      }
      const objective = goalArgs.join(' ');
      const content =
`# GOAL

> Durable objective the agent pursues across turns (kimi /goal). Created ${new Date().toISOString()}.

## Objective
${objective}

## Completion criterion
<verifiable end state that means done>

## Proof
<observable evidence: a command exit code, a test count, a grep/rg with no hits, a file that now exists>

## Boundaries
<scope the work may touch; what is off-limits>

## Stop rule
<when to stop and report instead of grinding on - e.g. an external blocker>

---
Written by \`kimi goal\`. The agent reads this file and works until the completion
criterion holds, then reports. Re-issue with \`kimi goal "<objective>"\` to replace.
`;
      const b64 = Buffer.from(content, 'utf8').toString('base64');
      return boxExec(cfg, `echo '${b64}' | base64 -d > GOAL.md`, { cwd: goalCwd, timeout: 30 });
    }
    case 'issue': {
      // Parse owner/repo#number or full URL
      const arg = rest[0] || '';
      let owner, repo, number;
      if (arg.includes('github.com')) {
        const m = arg.match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues\/)?(\d+)/);
        if (!m) { console.error('kimi: invalid GitHub issue URL'); return 2; }
        [, owner, repo, number] = m;
      } else {
        const m = arg.match(/^([^/]+)\/([^#]+)#(\d+)$/);
        if (!m) { console.error('kimi: expected owner/repo#number or GitHub URL'); return 2; }
        [, owner, repo, number] = m;
      }
      return fetchIssue(owner, repo, number);
    }
    case '-h': case '--help': usage(); return 0;
    case undefined:
      // No subcommand -> whole argv is the command (mirrors r.sh).
      return boxExec(cfg, argv.join(' '));
    default:
      return boxExec(cfg, argv.join(' '));
  }
}

// Special modes handled outside main() so the daemon never hits the exit-flush.
const SPECIAL = process.argv.slice(2)[0];
if (SPECIAL === '--ssh-daemon') {
  startSshDaemon(); // never returns: server + ssh keep the loop alive
} else if (SPECIAL === '--ssh-stop') {
  (async () => {
    if (!fs.existsSync(DAEMON_SOCK)) { console.log('kimi: no ssh daemon running'); process.exit(0); }
    const c = net.connect(DAEMON_SOCK);
    c.on('connect', () => sendFrame(c, { type: 'stop' }));
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
  })();
} else {
  // Wait for stdout/stderr to fully drain before exiting: forcing process.exit()
  // the instant the 'exit' frame lands truncates buffered output on a pipe — only
  // the first chunk of a multi-frame (multi-command) stream survives. Draining
  // first guarantees every byte the box sent reaches the caller.
  main().then((code) => {
    const c = code ?? 0;
    const flush = () => {
      if (process.stdout.writableLength > 0 || process.stderr.writableLength > 0) {
        process.stdout.once('drain', flush);
        process.stderr.once('drain', flush);
      } else {
        process.exit(c);
      }
    };
    flush();
  }).catch((e) => { console.error('kimi:', e.message); process.exit(2); });
}
