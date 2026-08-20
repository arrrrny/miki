// Muscle: apply several precise changes in one pass.
// miki maps kimi's MultiEdit to the multiedit arm — ordered edits, each unique.
export default {
  id: '09',
  name: 'MULTIEDIT',
  muscle: 'apply multiple edits to one file',
  brief: "write multi-rep.txt with 'x1' and 'x2', multiedit both to 'y1'/'y2', then grep to confirm.",
  async verify(ctx) {
    const w = await ctx.callTool('write_file', { path: 'multi-rep.txt', content: 'x1\nx2\n' });
    if (!w.ok) return { ok: false, note: w.error };
    const m = await ctx.callTool('multiedit', {
      path: 'multi-rep.txt',
      edits: [
        { old_string: 'x1', new_string: 'y1' },
        { old_string: 'x2', new_string: 'y2' },
      ],
    });
    if (!m.ok) return { ok: false, note: m.error };
    const r = await ctx.callTool('grep', { pattern: 'y[12]', glob: 'multi-rep.txt' });
    if (r.ok && /y1/.test(r.result) && /y2/.test(r.result)) return { ok: true };
    return { ok: false, note: r.ok ? `multiedit incomplete: ${JSON.stringify(r.result)}` : r.error };
  },
};
