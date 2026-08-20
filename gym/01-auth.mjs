// Muscle: get a session and hold the token.
// The runner already POSTed /session for you. The rep is understanding: every
// agent that drives miki must authenticate first and carry its token.
export default {
  id: '01',
  name: 'AUTH',
  muscle: 'get a session, hold the token',
  brief: 'POST /session with the Bearer secret returns a token. Prove you hold yours in ctx.token.',
  async verify(ctx) {
    if (ctx.token && /^[0-9a-f]+$/.test(ctx.token)) return { ok: true };
    return { ok: false, note: 'no valid token in ctx' };
  },
};
