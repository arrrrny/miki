#!/usr/bin/env node
// miki GYM — two phases. Phase 1 WARMUP reps grow the reflexes against the live
// server. Phase 2 EXERCISES hand the agent a brief and a workspace; the agent
// builds it solo, drops a .submitted marker, and the runner grades it with
// evaluate(workspace). Pass both boards and the gate opens to kimi.
//
//   node gym.mjs                              (miki must be live on MIKI_PORT)
//   MIKI_GYM_EXERCISES=skip node gym.mjs      (warmup only, skip graded exercises)
//   MIKI_GYM_TIMEOUT=30 node gym.mjs          (cap the exercise wait at 30s)
import https from 'node:https';
import WebSocket from 'ws';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MIKI_PORT || 7654);
const AUTH = process.env.MIKI_AUTH_SECRET || 'dev-secret-change-me';
const EXERCISE_TIMEOUT = Number(process.env.MIKI_GYM_TIMEOUT || 300);
const SKIP_EXERCISES = process.env.MIKI_GYM_EXERCISES === 'skip';

function postSession() {
  return new Promise((res, rej) => {
    const req = https.request(
      { hostname: 'localhost', port: PORT, path: '/session', method: 'POST', rejectUnauthorized: false, headers: { authorization: 'Bearer ' + AUTH } },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          const b = JSON.parse(d);
          b.ok ? res(b) : rej(new Error(b.error));
        });
      },
    );
    req.on('error', rej);
    req.end();
  });
}

function getTranscript(sid) {
  return new Promise((res, rej) => {
    const req = https.request(
      { hostname: 'localhost', port: PORT, path: `/transcript?session=${sid}`, method: 'GET', rejectUnauthorized: false, headers: { authorization: 'Bearer ' + AUTH } },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => res(JSON.parse(d)));
      },
    );
    req.on('error', rej);
    req.end();
  });
}

function openSession(token) {
  const ws = new WebSocket(`wss://localhost:${PORT}/ws?token=${token}`, { rejectUnauthorized: false });
  return new Promise((res, rej) => {
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}

function callTool(ws, tool, args, id = 1) {
  return new Promise((res) => {
    const on = (b) => {
      const f = JSON.parse(b.toString());
      if (f.type === 'result' && f.id === id) {
        ws.off('message', on);
        res(f);
      }
    };
    ws.on('message', on);
    ws.send(JSON.stringify({ type: 'call', id, tool, args }));
  });
}

function streamExec(ws, command) {
  return new Promise((res) => {
    const out = [];
    const on = (b) => {
      const f = JSON.parse(b.toString());
      if (f.type === 'stdout' || f.type === 'stderr') out.push(f.data);
      if (f.type === 'exit') {
        ws.off('message', on);
        res({ code: f.exitCode, output: out.join('') });
      }
    };
    ws.on('message', on);
    ws.send(JSON.stringify({ type: 'start', command }));
  });
}

async function waitForSubmit(workspace, timeoutSec) {
  const marker = path.join(workspace, '.submitted');
  const deadline = Date.now() + timeoutSec * 1000;
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        await fs.access(marker);
        return resolve(true);
      } catch {
        if (Date.now() >= deadline) return resolve(false);
        process.stdout.write('.');
        setTimeout(tick, 2000);
      }
    };
    tick();
  });
}

// Load every rep/exercise from gym/. A WARMUP rep exposes verify(ctx). A graded
// EXERCISE exposes evaluate(workspace). The runner splits by which is present.
const files = globSync('gym/*.mjs', { cwd: __dirname }).sort();
const modules = [];
for (const f of files) {
  const mod = await import(path.join(__dirname, f));
  if (mod.default) modules.push(mod.default);
}
const warmups = modules.filter((e) => typeof e.verify === 'function');
const exercises = modules.filter((e) => typeof e.evaluate === 'function');

const s = await postSession();
const ws = await openSession(s.token);
const ctx = {
  token: s.token,
  sessionId: s.sessionId,
  workspace: s.workspace,
  callTool: (t, a) => callTool(ws, t, a),
  exec: (c) => streamExec(ws, c),
  transcript: () => getTranscript(s.sessionId),
  log: (m) => process.stdout.write('    ' + m + '\n'),
};

console.log(`\nPHASE 1 — WARMUP (${warmups.length} rep(s)). Complete all before you exercise.\n`);

console.log('DROP CARD — at any point, if there is a mis-fire, STOP and drop a card:');
console.log('  node drop.mjs --agent <you> --did "..." --expected "..." --happened "..." --where "miki GYM"');
console.log('A mis-fire is not a mistake. It is a discovery. Drop it.\n');
let grown = 0;
for (const ex of warmups) {
  process.stdout.write(`[${ex.id}] ${ex.name}  (muscle: ${ex.muscle})\n    ${ex.brief}\n`);
  try {
    const r = await ex.verify(ctx);
    if (r && r.ok) {
      console.log('    GROWN\n');
      grown++;
    } else {
      console.log(`    WEAK — ${r?.note || 'false'}\n`);
      console.log(`    MIS-FIRE. Not a mistake — a signal. Drop a card:\n    node drop.mjs --agent <you> --where "miki GYM ${ex.id} ${ex.name}" --did "..." --expected "..." --happened "${r?.note || ''}"\n`);
    }
  } catch (e) {
    console.log(`    WEAK — ${e.message}\n`);
  }
}

console.log(`BOARD: ${grown}/${warmups.length} muscles grown.\n`);
const warmupOk = grown === warmups.length;
if (!warmupOk) {
  ws.close();
  console.log('NOT READY. Finish the warmup before any exercise.');
  process.exit(1);
}

console.log(`PHASE 2 — EXERCISES (${exercises.length}). Build it solo, then submit. The gate grades you.\n`);
let passed = 0;
for (const ex of exercises) {
  process.stdout.write(`[${ex.id}] ${ex.name}  (muscle: ${ex.muscle})\n    ${ex.brief}\n`);
  process.stdout.write(`    connect:   wss://localhost:${PORT}/ws?token=${s.token}\n`);
  process.stdout.write(`    workspace: ${s.workspace}\n`);
  if (SKIP_EXERCISES) {
    console.log('    SKIPPED (MIKI_GYM_EXERCISES=skip)\n');
    continue;
  }
  process.stdout.write(`    waiting for .submitted (${EXERCISE_TIMEOUT}s)\n    `);
  const submitted = await waitForSubmit(s.workspace, EXERCISE_TIMEOUT);
  if (!submitted) {
    console.log('\n    NO SUBMISSION within timeout.');
  }
  try {
    const r = await ex.evaluate(s.workspace);
    if (r && r.pass) {
      console.log(`    PASSED — ${r.notes || ''}\n`);
      passed++;
    } else {
      console.log(`    FAILED — ${r?.notes || 'evaluate returned false'}\n`);
      console.log(`    MIS-FIRE. Not a mistake — a signal. Drop a card:\n    node drop.mjs --agent <you> --where "miki GYM ${ex.id} ${ex.name}" --did "..." --expected "..." --happened "${r?.notes || ''}"\n`);
    }
  } catch (e) {
    console.log(`    FAILED — ${e.message}\n`);
  }
}
ws.close();

console.log(`EXERCISES: ${passed}/${exercises.length} passed.`);
if (SKIP_EXERCISES) {
  console.log('READY (warmup). Exercises skipped — rerun without MIKI_GYM_EXERCISES=skip to clear the gate.');
  process.exit(0);
}
if (passed < exercises.length) {
  console.log('GATE CLOSED. You did not clear the exercises. No kimi for you.');
  process.exit(1);
}
console.log('GATE OPEN. You wield miki. Control kimi.');
