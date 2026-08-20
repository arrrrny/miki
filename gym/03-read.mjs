// Muscle: read a file back.
// Writing blind is worthless. The surgeon confirms what the arms produced.
export default {
  id: '03',
  name: 'READ',
  muscle: 'read a file back',
  brief: 'read_file gym-rep.txt and confirm you get exactly "rep".',
  async verify(ctx) {
    const r = await ctx.callTool('read_file', { path: 'gym-rep.txt' });
    if (r.ok && r.result === 'rep') return { ok: true };
    return { ok: false, note: r.ok ? `got ${JSON.stringify(r.result)}` : r.error };
  },
};
