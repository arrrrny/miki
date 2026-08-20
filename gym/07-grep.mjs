// Muscle: find the signal in the noise before you cut.
// The surgeon greps the field. miki maps kimi's Grep to the grep arm.
export default {
  id: '07',
  name: 'GREP',
  muscle: 'search file contents in the workspace',
  brief: "write grep-rep.txt with a 'ZNEEDLE' line, then grep for ZNEEDLE and confirm the hit.",
  async verify(ctx) {
    const w = await ctx.callTool('write_file', { path: 'grep-rep.txt', content: 'ZNEEDLE here\nnoise line\n' });
    if (!w.ok) return { ok: false, note: w.error };
    const r = await ctx.callTool('grep', { pattern: 'ZNEEDLE', glob: 'grep-rep.txt' });
    if (r.ok && /ZNEEDLE/.test(r.result)) return { ok: true };
    return { ok: false, note: r.ok ? `grep missed: ${JSON.stringify(r.result)}` : r.error };
  },
};
