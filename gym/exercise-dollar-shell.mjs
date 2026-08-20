// Graded exercise — the shell $ trap. Through the exec (Bash) arm, the agent
// must keep a literal $5, not let the shell expand it as a positional param.
// Right: echo 'it costs $5 today' (single quotes) or escaped double quotes.
import fs from 'node:fs/promises';
import path from 'node:path';

export default {
  id: 'E10',
  name: 'SHELL $',
  muscle: 'keep a literal $ through the exec (shell) arm',
  brief:
    "Use the exec arm to write quot.txt containing exactly: it costs $5 today  " +
    '(the $5 must be literal, not a shell variable). Then leave a .submitted marker.',
  async evaluate(workspace) {
    let txt;
    try {
      txt = await fs.readFile(path.join(workspace, 'quot.txt'), 'utf8');
    } catch {
      return { pass: false, notes: 'no quot.txt in workspace' };
    }
    if (txt.trim() !== 'it costs $5 today') {
      return { pass: false, notes: `quot.txt was not literal '$5': ${JSON.stringify(txt)}` };
    }
    return { pass: true, notes: 'quot.txt keeps literal $5 through the shell' };
  },
};
