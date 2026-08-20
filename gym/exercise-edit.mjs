// Graded exercise — prove you can change the box precisely.
// Edit/MultiEdit is the scalpel. Set the placeholders to real values.
import fs from 'node:fs/promises';
import path from 'node:path';

export default {
  id: 'E7',
  name: 'EDIT',
  muscle: 'rewrite placeholders with the edit/multiedit arm',
  brief:
    "Create src/config.txt with 'NAME=REPLACE_ME' on one line and 'MODE=REPLACE_ME' " +
    'on the next. Use the edit (or multiedit) tool to set NAME=AGENT and MODE=LIVE. ' +
    'Leave a .submitted marker.',
  async evaluate(workspace) {
    let cfg;
    try {
      cfg = await fs.readFile(path.join(workspace, 'src', 'config.txt'), 'utf8');
    } catch {
      return { pass: false, notes: 'no src/config.txt in workspace' };
    }
    if (/REPLACE_ME/.test(cfg)) return { pass: false, notes: 'placeholders not replaced' };
    if (!/NAME=AGENT/.test(cfg) || !/MODE=LIVE/.test(cfg)) {
      return { pass: false, notes: 'NAME=AGENT and MODE=LIVE not both set' };
    }
    return { pass: true, notes: 'config rewritten to NAME=AGENT MODE=LIVE' };
  },
};
