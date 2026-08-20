// Graded exercise E4 — take input, compute, output.
// Warmup proved you can write and run. This proves you can read argv and compute
// a graded result, then submit it for evaluation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export default {
  id: 'E4',
  name: 'ADD',
  muscle: 'read argv and compute in the box',
  brief:
    'Write add.mjs in your workspace that reads two numbers from process.argv ' +
    '(after the node path) and prints their sum. Then leave a .submitted marker.',
  async evaluate(workspace) {
    let code;
    try {
      code = await fs.readFile(path.join(workspace, 'add.mjs'), 'utf8');
    } catch {
      return { pass: false, notes: 'no add.mjs in the workspace' };
    }
    if (!/process\.argv/.test(code)) {
      return { pass: false, notes: 'add.mjs does not read process.argv' };
    }
    const r = spawnSync('node', [path.join(workspace, 'add.mjs'), '2', '3'], { encoding: 'utf8' });
    if (r.status !== 0) return { pass: false, notes: 'add.mjs exited non-zero: ' + r.stderr };
    if ((r.stdout || '').trim() !== '5') return { pass: false, notes: 'add.mjs 2 3 did not print 5' };
    return { pass: true, notes: 'add.mjs reads argv and sums' };
  },
};
