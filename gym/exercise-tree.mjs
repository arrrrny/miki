// Graded exercise E5 — build a structure, not just a file.
// Warmup proved you can write a file. This proves you can lay out a directory
// and put runnable code inside it, then submit for evaluation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export default {
  id: 'E5',
  name: 'TREE',
  muscle: 'build a directory structure in the box',
  brief:
    "Create app/main.mjs in your workspace that prints 'APP'. Then leave a " +
    '.submitted marker.',
  async evaluate(workspace) {
    const main = path.join(workspace, 'app', 'main.mjs');
    try {
      await fs.readFile(main, 'utf8');
    } catch {
      return { pass: false, notes: 'no app/main.mjs in the workspace' };
    }
    const r = spawnSync('node', [main], { encoding: 'utf8' });
    if (r.status !== 0) return { pass: false, notes: 'app/main.mjs exited non-zero: ' + r.stderr };
    if ((r.stdout || '').trim() !== 'APP') return { pass: false, notes: 'app/main.mjs did not print APP' };
    return { pass: true, notes: 'app/main.mjs prints APP' };
  },
};
