#!/usr/bin/env node
// cloud-agent.mjs — minimal cloud-agent (the surgeon) driving miki's arms.
//
// This is the verification harness for miki's core contract: a cloud agent
// connects, is issued a kimi session, drives the arms over WSS/REST, and every
// action lands in the kimi transcript. Run miki first (npm start), then:
//   node cloud-agent.mjs
//
// It answers one question precisely: does miki create kimi sessions, and does
// the session-scoped tool surface actually work end-to-end?

import { WebSocket } from 'ws';

const BASE = process.env.MIKI_BASE || 'https://localhost:7654';
const SECRET = process.env.MIKI_AUTH_SECRET || 'dev-secret-change-me';
const TLS_OPTS = { rejectUnauthorized: false };

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function session() {
  const r = await fetch(`${BASE}/session`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + SECRET },
    ...TLS_OPTS,
  });
  return { status: r.status, body: await r.json() };
}

async function transcript(sid) {
  const r = await fetch(`${BASE}/transcript?session=${sid}`, {
    headers: { Authorization: 'Bearer ' + SECRET },
    ...TLS_OPTS,
  });
  return (await r.json()).entries;
}

// One WSS socket drives everything: {type:"call",id} -> result, {type:"start"} -> exec frames.
function driveWs(token, calls) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/ws?token=${token}`, TLS_OPTS);
    const results = {};
    const pending = new Set(calls.map((c) => c.id));
    ws.on('open', () => {
      for (const c of calls) {
        if (c.type === 'start') ws.send(JSON.stringify({ type: 'start', command: c.command, cwd: c.cwd, timeout: c.timeout }));
        else ws.send(JSON.stringify({ type: 'call', id: c.id, tool: c.tool, args: c.args }));
      }
    });
    ws.on('message', (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === 'result') {
        results[m.id] = m;
        pending.delete(m.id);
        if (!pending.size && !calls.some((c) => c.type === 'start')) ws.close();
      } else if (m.type === 'exit') {
        results.__exit = m.exitCode;
        if (!pending.size) ws.close();
      }
    });
    ws.on('error', reject);
    ws.on('close', () => resolve(results));
  });
}

async function main() {
  // 1) SESSION CREATION — the first thing a cloud agent does.
  const { status, body } = await session();
  check('POST /session returns 200', status === 200, `status=${status}`);
  check('creates a kimi session (sessionId)', !!body.sessionId, `id=${body.sessionId}`);
  check('issues a bearer token', typeof body.token === 'string' && body.token.length > 0, `token=${body.token?.slice(0, 8)}…`);
  check('allocates an isolated workspace', !!body.workspace, `ws=${body.workspace}`);
  const { token, sessionId, workspace } = body;

  // 2) DRIVE THE ARMS over the unified WSS session (scoped to the workspace).
  const calls = [
    { id: 'w', type: 'call', tool: 'write_file', args: { path: 'probe.txt', content: 'miki arms engaged\n' } },
    { id: 'r', type: 'call', tool: 'read_file', args: { path: 'probe.txt' } },
    { id: 'l', type: 'call', tool: 'list_files', args: { pattern: '*' } },
    { type: 'start', command: 'echo miki-ok && pwd', timeout: 10 },
  ];
  const res = await driveWs(token, calls);

  check('write_file arm works', res.w?.ok === true, JSON.stringify(res.w?.result || res.w?.error));
  check('read_file arm reads it back', res.r?.ok === true && /miki arms engaged/.test(res.r.result || ''), (res.r?.result || res.r?.error || '').trim());
  check('list_files arm sees the file', res.l?.ok === true && /probe\.txt/.test(res.l.result || ''), (res.l?.result || '').trim());
  check('exec arm streams + exits 0', res.__exit === 0, `exitCode=${res.__exit}`);

  // 3) KIMI TRANSCRIPT — proof the session audited every mirrored command.
  const entries = await transcript(sessionId);
  const kimi = new Set(entries.map((e) => e.kimi));
  check('session creates a kimi Session entry', kimi.has('Session'), `entries=${entries.length}`);
  check('transcript mirrors Read', kimi.has('Read'));
  check('transcript mirrors Write', kimi.has('Write'));
  check('transcript mirrors Glob', kimi.has('Glob'));
  check('transcript mirrors Bash (exec)', kimi.has('Bash'));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log('FAILURES:', failed.map((f) => f.name).join(', '));
    process.exitCode = 1;
  } else {
    console.log('miki really works: kimi sessions are created and the arms execute through them.');
  }
}

main().catch((e) => {
  console.error('driver error:', e.message || e);
  process.exit(1);
});
