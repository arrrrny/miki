// Graded exercise E3 — build and run a script in the box.
// Warmup proved you can write and exec. This proves you can build something that
// runs and produces a graded output, then submit it for evaluation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export default {
  id: 'E3',
  name: 'ECHO',
  muscle: 'build and run a script in the box',
  brief:
    'Write echo.mjs in your workspace that prints the current date as an ISO string ' +
    '(new Date().toISOString()). Then leave a .submitted marker.',
  async evaluate(workspace) {
    let code;
    try {
      code = await fs.readFile(path.join(workspace, 'echo.mjs'), 'utf8');
    } catch {
      return { pass: false, notes: 'no echo.mjs in the workspace' };
    }
    if (!/Date\(\)\.toISOString\(\)/.test(code)) {
      return { pass: false, notes: 'echo.mjs does not call new Date().toISOString()' };
    }
    const r = spawnSync('node', [path.join(workspace, 'echo.mjs')], { encoding: 'utf8' });
    if (r.status !== 0) return { pass: false, notes: 'echo.mjs exited non-zero: ' + r.stderr };
    if (!/^\d{4}-\d{2}-\d{2}T/.test((r.stdout || '').trim())) {
      return { pass: false, notes: 'echo.mjs did not print an ISO date' };
    }
    return { pass: true, notes: 'echo.mjs prints an ISO date' };
  },
};
