#!/usr/bin/env node
// Spawns the miki server (HTTPS+WSS), runs a minimal cloud-agent read, then exits.
// One command to see the inverse-kimi loop end to end: no provider anywhere.

import { spawn } from 'node:child_process';
import https from 'node:https';

const PORT = Number(process.env.MIKI_PORT || 7654);
const BASE = `https://localhost:${PORT}`;

const server = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, MIKI_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});

await new Promise((resolve) => {
  const onData = (chunk) => {
    if (chunk.toString().includes('listening')) {
      server.stdout.off('data', onData);
      resolve();
    }
  };
  server.stdout.on('data', onData);
});

function call(tool, args) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      BASE + '/tools/call',
      { method: 'POST', headers: { 'content-type': 'application/json' }, rejectUnauthorized: false },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ tool, args }));
  });
}

const target = process.argv[2] || 'sample.txt';
const out = await call('read_file', { path: target });
if (!out.ok) {
  console.error('[agent] tool failed:', out.error);
  server.kill();
  process.exit(1);
}
console.log('[agent] read "' + target + '":\n' + out.result);
console.log('\n[agent] done — no provider required.');
server.kill();
