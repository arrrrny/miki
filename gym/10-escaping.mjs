// Muscle: emit a literal $ in Dart without tripping string interpolation.
// The surgeon must escape $ or the box refuses to compile. miki maps kimi
// Write + Exec to the arms, so the escaping happens through the tools.
export default {
  id: '10',
  name: 'ESCAPE',
  muscle: 'write and run Dart that prints a literal $',
  brief:
    "write price.dart whose code prints the literal '$5.00', exec `dart run price.dart`, " +
    "and confirm the output carries '$5.00'.",
  async verify(ctx) {
    const w = await ctx.callTool('write_file', {
      path: 'price.dart',
      content: "void main() { print('\\$5.00'); }\n",
    });
    if (!w.ok) return { ok: false, note: w.error };
    const r = await ctx.exec('dart run price.dart');
    if (r.code === 0 && r.output.includes('$5.00')) return { ok: true };
    return { ok: false, note: `code=${r.code} out=${JSON.stringify(r.output)}` };
  },
};
