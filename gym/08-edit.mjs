// Muscle: change one thing precisely, without disturbing the rest.
// miki maps kimi's Edit to the edit arm. Old string must be unique.
export default {
  id: '08',
  name: 'EDIT',
  muscle: 'replace a string in a file',
  brief: "write edit-rep.txt with 'oldtoken', edit it to 'newtoken', then grep to confirm the swap.",
  async verify(ctx) {
    const w = await ctx.callTool('write_file', { path: 'edit-rep.txt', content: 'oldtoken\nkeep this\n' });
    if (!w.ok) return { ok: false, note: w.error };
    const e = await ctx.callTool('edit', { path: 'edit-rep.txt', old_string: 'oldtoken', new_string: 'newtoken' });
    if (!e.ok) return { ok: false, note: e.error };
    const r = await ctx.callTool('grep', { pattern: 'newtoken', glob: 'edit-rep.txt' });
    if (r.ok && /newtoken/.test(r.result) && !/oldtoken/.test(r.result)) return { ok: true };
    return { ok: false, note: r.ok ? `swap not clean: ${JSON.stringify(r.result)}` : r.error };
  },
};
