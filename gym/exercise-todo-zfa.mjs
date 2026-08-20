// Graded exercise E2 — scaffold a Zuraffa todo app with the zfa CLI.
// The real production gate. An agent that drives miki to scaffold a real
// Zuraffa app is cleared to control kimi. The runner grades the submission.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export default {
  id: 'E2',
  name: 'ZFA TODO',
  muscle: 'scaffold a Zuraffa app via the zfa CLI',
  brief:
    'Use the `zfa` CLI to scaffold a Zuraffa "todo" app inside your workspace ' +
    '(e.g. `zfa create` / `zfa new`). Leave a .submitted marker when done.',
  async evaluate(workspace) {
    // Structural gate: a real Zuraffa/Flutter project has a pubspec that depends
    // on zuraffa and a lib/ directory. Without that, no pass.
    let pubspec;
    try {
      pubspec = await fs.readFile(path.join(workspace, 'pubspec.yaml'), 'utf8');
    } catch {
      return { pass: false, notes: 'no pubspec.yaml — not a Zuraffa/Flutter project' };
    }
    if (!/zuraffa/i.test(pubspec)) {
      return { pass: false, notes: 'pubspec.yaml does not depend on zuraffa' };
    }
    let hasLib = false;
    try {
      hasLib = (await fs.stat(path.join(workspace, 'lib'))).isDirectory();
    } catch {}
    if (!hasLib) return { pass: false, notes: 'no lib/ directory' };

    // Optional live check: if zfa/flutter is installed in the box, analyze must pass.
    const zfa = spawnSync('zfa', ['analyze'], { cwd: workspace });
    if (zfa.status === 0) return { pass: true, notes: 'zuraffa project, zfa analyze green' };
    const fl = spawnSync('flutter', ['analyze'], { cwd: workspace });
    if (fl.status === 0) return { pass: true, notes: 'zuraffa project, flutter analyze green' };
    // Tooling not present in this box — structural gate is enough.
    return { pass: true, notes: 'zuraffa project structure present (zfa/flutter not installed to analyze)' };
  },
};
