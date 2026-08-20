// Graded exercise — the Dart $ trap. The agent must write code that emits a
// literal dollar sign, not an interpolation. Wrong code: print('$5.00') ->
// compile error. Right: print('\$5.00') or a raw string.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export default {
  id: 'E9',
  name: 'DART $',
  muscle: 'emit a literal $ in Dart (escape interpolation)',
  brief:
    "Write price.dart in your workspace that prints the exact text '$5.00' " +
    '(dollar sign included). Then leave a .submitted marker.',
  async evaluate(workspace) {
    let code;
    try {
      code = await fs.readFile(path.join(workspace, 'price.dart'), 'utf8');
    } catch {
      return { pass: false, notes: 'no price.dart in workspace' };
    }
    const r = spawnSync('dart', ['run', 'price.dart'], { cwd: workspace, encoding: 'utf8' });
    if (r.status !== 0) return { pass: false, notes: 'price.dart failed: ' + (r.stderr || r.stdout) };
    if ((r.stdout || '').trim() !== '$5.00') {
      return { pass: false, notes: `price.dart output was not exactly '$5.00': ${JSON.stringify(r.stdout)}` };
    }
    return { pass: true, notes: 'price.dart prints literal $5.00' };
  },
};
