// Muscle: locate before you act.
// The surgeon scans the field before the cut. List what is in the box.
export default {
  id: '06',
  name: 'LIST',
  muscle: 'list files in the workspace',
  brief: "list_files the workspace and confirm 'gym-rep.txt' (written by the WRITE rep) shows up.",
  async verify(ctx) {
    const r = await ctx.callTool('list_files', { pattern: 'gym-rep*' });
    if (r.ok && /gym-rep\.txt/.test(r.result)) return { ok: true };
    return { ok: false, note: r.ok ? `list did not show gym-rep.txt: ${JSON.stringify(r.result)}` : r.error };
  },
};
