#!/usr/bin/env node
// Cloud-agent demo over a unified WSS session: one socket drives read/write/list
// (request/response frames) and exec (streaming frames). No provider, no API key.
// The agent first authenticates (POST /session) to get an isolated workspace +
// token, then connects to WSS /ws?token=<token>. miki's arms perform each kimi
// command inside the agent's own box, exactly as kimi itself would.

import WebSocket from 'ws';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MIKI_PORT || 7654);
const AUTH_SECRET = process.env.MIKI_AUTH_SECRET || 'dev-secret-change-me';
const ROOT = path.resolve(__dirname);
const TMP = 'demo.txt';

function postSession() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'localhost',
        port: PORT,
        path: '/session',
        method: 'POST',
        rejectUnauthorized: false,
        headers: { authorization: 'Bearer ' + AUTH_SECRET },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const body = JSON.parse(data);
          if (!body.ok) return reject(new Error(body.error || 'session failed'));
          resolve(body);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const { token, workspace } = await postSession();
  console.log(`[agent] authed -> isolated workspace ${path.basename(workspace)}\n`);

  const WS_URL = `wss://localhost:${PORT}/ws?token=${token}`;
  const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
  const pending = new Map();
  let nextId = 1;

  ws.on('message', (buf) => {
    const f = JSON.parse(buf.toString());
    if (f.type === 'result') {
      const cb = pending.get(f.id);
      if (cb) {
        pending.delete(f.id);
        cb(f);
      }
    } else if (f.type === 'stdout') process.stdout.write(f.data);
    else if (f.type === 'stderr') process.stderr.write(f.data);
    else if (f.type === 'exit') {
      console.log(`\n[agent] arms report exit code ${f.exitCode} (no provider required).`);
      finish();
    } else if (f.type === 'error') console.error(`\n[agent] arms error: ${f.message}`);
  });

  function call(tool, args) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type: 'call', id, tool, args }));
    });
  }

  async function finish() {
    await fs.rm(path.join(workspace, TMP), { force: true });
    ws.close();
  }

  ws.on('error', (e) => {
    console.error('[agent] wss error:', e.message);
    process.exit(2);
  });

  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  console.log(`[agent] connected to miki WSS ${WS_URL} (unified session)\n`);

  const w = await call('write_file', { path: TMP, content: 'written by cloud agent via miki\n' });
  console.log('[write_file -> kimi Write]: ' + (w.ok ? w.result : w.error));

  const r = await call('read_file', { path: TMP });
  console.log('[read_file -> kimi Read]:\n' + (r.ok ? r.result : r.error));

  const l = await call('list_files', { pattern: '*.mjs' });
  console.log('[list_files -> kimi Glob]:\n' + (l.ok ? l.result : l.error));

  console.log('\n[exec -> kimi Bash] (streaming):');
  ws.send(
    JSON.stringify({
      type: 'start',
      command: process.argv.slice(2).join(' ') || 'dart run dart_demo/stream.dart',
    }),
  );
}

main().catch((e) => {
  console.error('[agent] fatal:', e.message);
  process.exit(1);
});
