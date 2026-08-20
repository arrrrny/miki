#!/usr/bin/env node
// miki bootstrap — launch miki inside a sandbox (e.g. a Daytona box) and expose
// the connect URL, so a cloud agent (the surgeon) runs in its own sandbox and
// connects to this miki (the arms). No provider: the agent brings the brain.
//
//   cloud agent ──POST /session (Bearer secret)──► token + isolated workspace
//              ──WSS /ws?token=<token>──────────► drives read/write/exec (kimi)
//
// The bootstrap derives the PUBLIC base URL from common sandbox env vars
// (DAYTONA_WORKSPACE_URL / DAYTONA_PUBLIC_URL / MIKI_PUBLIC_URL) and falls back
// to localhost for local runs.

import crypto from 'node:crypto';

const PORT = Number(process.env.MIKI_PORT || 7654);

// Generate a secret if one isn't supplied, then set it BEFORE importing the
// server module (server.mjs reads MIKI_AUTH_SECRET at import time).
const AUTH_SECRET = process.env.MIKI_AUTH_SECRET || crypto.randomBytes(24).toString('hex');
process.env.MIKI_AUTH_SECRET = AUTH_SECRET;

const { createServer } = await import('./server.mjs');

const PUBLIC =
  process.env.DAYTONA_WORKSPACE_URL ||
  process.env.DAYTONA_PUBLIC_URL ||
  process.env.MIKI_PUBLIC_URL ||
  `https://localhost:${PORT}`;
const base = PUBLIC.replace(/\/$/, '');
const wsBase = base.replace(/^http/, 'ws');

const { server, wss } = createServer();
server.listen(PORT, () => {
  console.log('miki bootstrap: inverse-kimi tool server is LIVE');
  console.log(`  listening on        : ${PORT}`);
  console.log(`  auth secret (Bearer): ${AUTH_SECRET}`);
  console.log(`  agent connect WSS   : ${wsBase}/ws`);
  console.log(`  session handshake   : POST ${base}/session`);
  console.log(`                         (Authorization: Bearer ${AUTH_SECRET})`);
  console.log('');
  console.log('  cloud agents: POST /session -> use returned token on WSS /ws?token=<token>');
});

function shutdown() {
  wss.close(() => server.close(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
