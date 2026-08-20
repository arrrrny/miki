// Muscle: read your own transcript.
// Every move the arms make is recorded as a kimi command. A disciplined surgeon
// audits the record. Confirm your session logged Write, Read, and Bash.
export default {
  id: '05',
  name: 'AUDIT',
  muscle: 'read your own transcript',
  brief: 'Fetch your transcript. Confirm it records Write, Read, and Bash as kimi commands.',
  async verify(ctx) {
    const t = await ctx.transcript();
    const k = t.entries.map((e) => e.kimi);
    if (k.includes('Write') && k.includes('Read') && k.includes('Bash')) return { ok: true };
    return { ok: false, note: `missing kimi cmds, got ${k.join(',')}` };
  },
};
