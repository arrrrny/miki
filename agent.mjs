#!/usr/bin/env node
// Minimal cloud-agent demo: connect to miki (HTTPS), list tools, read a file.
// This is the "inverse kimi" — the agent supplies the brain, miki the hands.
// No provider, no API key. Replace this script with your own LLM-driven loop.

import https from 'node:https';

const PORT = Number(process.env.MIKI_PORT || 7654);
const BASE = `https://localhost:${PORT}`;
const OPTS = { rejectUnauthorized: false };

function getJson(path) {
  return new Promise((resolve, reject) => {
    https
      .get(BASE + path, OPTS, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      })
      .on('error', reject);
  });
}

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

async function main() {
  const tools = await getJson('/tools');
  console.log('[agent] connected to miki. available tools:');
  for (const t of tools.tools) {
    console.log(`  - ${t.name} (kimi:${t.kimi}, ${t.transport}): ${t.description}`);
  }

  const target = process.argv[2] || 'sample.txt';
  console.log(`[agent] reading "${target}" (no provider needed)...`);

  const out = await call('read_file', { path: target });
  if (!out.ok) {
    console.error('[agent] tool failed:', out.error);
    process.exit(1);
  }

  console.log('[agent] result:\n' + out.result);
  console.log('\n[agent] done. a real cloud agent would now plan & edit files using these tools.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
