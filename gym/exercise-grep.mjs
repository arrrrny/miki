// Graded exercise — prove you can search the box after you build in it.
// Grep is how the surgeon verifies their own work before the next cut.
import fs from 'node:fs/promises';
import path from 'node:path';

export default {
  id: 'E6',
  name: 'GREP',
  muscle: 'leave a searchable signal in the box',
  brief:
    "Create notes.md in your workspace containing the exact line 'KIMI_INVERSE_OK'. " +
    'Then leave a .submitted marker.',
  async evaluate(workspace) {
    let notes;
    try {
      notes = await fs.readFile(path.join(workspace, 'notes.md'), 'utf8');
    } catch {
      return { pass: false, notes: 'no notes.md in workspace' };
    }
    if (!/KIMI_INVERSE_OK/.test(notes)) {
      return { pass: false, notes: 'notes.md does not contain KIMI_INVERSE_OK' };
    }
    return { pass: true, notes: 'notes.md carries the KIMI_INVERSE_OK signal' };
  },
};
