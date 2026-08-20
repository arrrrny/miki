// Graded exercise E1 — plan a build in the box.
// Warmup grows the reflex. This proves it under load: the agent must plan its
// own work in the box, then submit. The runner grades the submission.
import fs from 'node:fs/promises';
import path from 'node:path';

export default {
  id: 'E1',
  name: 'PLAN',
  muscle: 'plan a build in the box',
  brief:
    'Write PLAN.md in your workspace that plans a "todo" app to be built with miki. ' +
    'It must mention both "todo" and "miki". Then leave a .submitted marker to submit.',
  async evaluate(workspace) {
    let plan;
    try {
      plan = (await fs.readFile(path.join(workspace, 'PLAN.md'), 'utf8')).toLowerCase();
    } catch {
      return { pass: false, notes: 'no PLAN.md in workspace' };
    }
    if (!plan.includes('todo')) return { pass: false, notes: 'PLAN.md does not mention todo' };
    if (!plan.includes('miki')) return { pass: false, notes: 'PLAN.md does not mention miki' };
    if (plan.trim().length < 30) return { pass: false, notes: 'PLAN.md too short to be a real plan' };
    return { pass: true, notes: 'plan mentions todo + miki' };
  },
};
