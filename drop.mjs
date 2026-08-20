#!/usr/bin/env node
// drop-card — capture a mis-fire as a DROP CARD.
// A mis-fire is NOT a mistake. An unexpected outcome can be a huge discovery.
// Drop a card: "I did X, expecting Y and Z happened, SO I DROPPED."
//
//   node drop.mjs --agent <id> --did "<X>" --expected "<Y>" --happened "<Z>" \
//                 [--where "<context>"] [--discovery]
//
// Writes drops/DROP-<agent>-<date>.md and (if `gh` is present) opens a GitHub
// issue. The local drop and the issue are redundant copies of the same card.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const agent = arg('agent') || 'agent';
const did = arg('did');
const expected = arg('expected');
const happened = arg('happened');
const where = arg('where') || 'unspecified';
const discovery = process.argv.includes('--discovery');

if (!did || !expected || !happened) {
  console.error('DROP CARD needs --did, --expected, --happened');
  process.exit(1);
}

const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = `DROP-${agent}-${date}.md`;
const dir = path.join(__dirname, 'drops');
await fs.mkdir(dir, { recursive: true });
const p = path.join(dir, file);

const body = `# DROP CARD — ${agent} — ${date}

I did ${did}, expecting ${expected} and ${happened}, SO I DROPPED.

- Agent: ${agent}
- When: ${date}
- Where: ${where}
- Discovery: ${discovery ? 'YES — unexpected outcome, extra attention' : 'no'}

## The card
- Did (X): ${did}
- Expected (Y): ${expected}
- Happened (Z): ${happened}

A mis-fire is not a mistake. It is a signal. Treat it.
`;

await fs.writeFile(p, body, 'utf8');
console.log(`DROP CARD written: ${p}`);

const gh = spawnSync('gh', ['--version'], { encoding: 'utf8' });
if (gh.status === 0) {
  const title = `[DROP] ${agent}: ${happened.slice(0, 80)}`;
  const issue = spawnSync('gh', ['issue', 'create', '--title', title, '--body', body], { encoding: 'utf8' });
  if (issue.status === 0) {
    console.log('GitHub issue opened.');
  } else {
    const msg = (issue.stderr || '').trim().split('\n')[0];
    console.log('GitHub issue skipped (not in a repo or not authed): ' + msg);
  }
} else {
  console.log('`gh` not found — local drop only. Open the issue manually if wanted.');
}
