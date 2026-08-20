// Graded exercise — prove you can see the shape of the box.
// Glob is how the surgeon surveys before acting.
import fs from 'node:fs/promises';
import path from 'node:path';

export default {
  id: 'E8',
  name: 'GLOB',
  muscle: 'lay out files and confirm them with list_files',
  brief:
    'Create three files at the workspace root: a.txt, b.txt, c.txt (any content). ' +
    'Use list_files (Glob) to confirm they appear. Leave a .submitted marker.',
  async evaluate(workspace) {
    const need = ['a.txt', 'b.txt', 'c.txt'];
    for (const f of need) {
      try {
        await fs.access(path.join(workspace, f));
      } catch {
        return { pass: false, notes: `missing ${f}` };
      }
    }
    return { pass: true, notes: 'a.txt, b.txt, c.txt all present' };
  },
};
