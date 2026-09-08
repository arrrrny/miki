// Cloud-agent driver: proves miki's WSS `exec` (the Bash mirror) end-to-end
// against the real task repo. Starts nothing — miki must already be running on
// :7654 with MIKI_ROOT=/workspace. Run from /workspace/miki so `ws` resolves.
import WebSocket from 'ws';

const BASE = 'https://localhost:7654';
const SECRET = 'dev-secret-change-me';

const s = await (await fetch(`${BASE}/session`, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + SECRET, 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspace: '/workspace/herdr' }),
})).json();
console.log('SESSION', s.sessionId, '\nWS', s.workspace);

const tok = s.token;
const ws = new WebSocket(`${BASE}/ws?token=${tok}`, { rejectUnauthorized: false });

const cmd = [
  'echo "=== cargo ==="; cargo --version 2>&1',
  'echo "=== git status (herdr) ==="; git -C /workspace/herdr status --short',
  'echo "=== git log ==="; git -C /workspace/herdr log --oneline -3',
  'echo "=== uncommitted diff stat ==="; git -C /workspace/herdr diff --stat',
].join('\n');

ws.on('open', () =>
  ws.send(JSON.stringify({ type: 'start', command: cmd, cwd: '/workspace/herdr', timeout: 120 })),
);
ws.on('message', (m) => {
  const f = JSON.parse(m.toString());
  if (f.type === 'stdout' || f.type === 'stderr') process.stdout.write(f.data);
  else if (f.type === 'exit') {
    console.log('\n*** miki exec exit', f.exitCode, '***');
    process.exit(0);
  } else if (f.type === 'error') {
    console.log('ERR', f.message);
    process.exit(2);
  }
});
ws.on('error', (e) => {
  console.log('WSERR', e.message);
  process.exit(2);
});
