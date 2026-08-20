// Muscle: write a file into your isolated workspace.
// miki is the arms; you are the surgeon. The first thing you must be able to do
// is leave your mark in the box.
export default {
  id: '02',
  name: 'WRITE',
  muscle: 'write a file into your workspace',
  brief: 'Use write_file to create gym-rep.txt in your workspace with the content "rep".',
  async verify(ctx) {
    const r = await ctx.callTool('write_file', { path: 'gym-rep.txt', content: 'rep' });
    if (r.ok) return { ok: true };
    return { ok: false, note: r.error };
  },
};
