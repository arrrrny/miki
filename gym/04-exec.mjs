// Muscle: run a command in the box and watch it stream.
// This is kimi's Bash, mapped to miki's exec. The surgeon must feel the live
// stdout/stderr/exit pulse before being trusted with real work.
export default {
  id: '04',
  name: 'EXEC',
  muscle: 'run a command in the box',
  brief: 'exec "echo miki" and confirm the output carries "miki" with exit code 0.',
  async verify(ctx) {
    const r = await ctx.exec('echo miki');
    if (r.code === 0 && r.output.includes('miki')) return { ok: true };
    return { ok: false, note: `code=${r.code} out=${JSON.stringify(r.output)}` };
  },
};
