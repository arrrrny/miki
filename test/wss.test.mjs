import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { WebSocket } from 'ws';
import { createServer, AUTH_SECRET } from '../server.mjs';

function postSession(port, secret = AUTH_SECRET) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'localhost',
        port,
        path: '/session',
        method: 'POST',
        rejectUnauthorized: false,
        headers: { authorization: 'Bearer ' + secret },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const b = JSON.parse(data);
          if (!b.ok) return reject(new Error(b.error));
          resolve(b);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function openSession(port, token) {
  const ws = new WebSocket(`wss://localhost:${port}/ws?token=${token}`, { rejectUnauthorized: false });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function callTool(ws, tool, args, id = 1) {
  return new Promise((resolve) => {
    const onMsg = (buf) => {
      const f = JSON.parse(buf.toString());
      if (f.type === 'result' && f.id === id) {
        ws.off('message', onMsg);
        resolve(f);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'call', id, tool, args }));
  });
}

function streamExec(ws, command) {
  return new Promise((resolve) => {
    const frames = [];
    const onMsg = (buf) => {
      const f = JSON.parse(buf.toString());
      if (f.type === 'stdout' || f.type === 'stderr') frames.push(f.data);
      if (f.type === 'exit') {
        ws.off('message', onMsg);
        resolve({ code: f.exitCode, output: frames.join('') });
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'start', command }));
  });
}

function getTranscript(port, session, secret = AUTH_SECRET) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'localhost',
        port,
        path: `/transcript?session=${session}`,
        method: 'GET',
        rejectUnauthorized: false,
        headers: { authorization: 'Bearer ' + secret },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(JSON.parse(data)));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  const { server, wss } = createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((r) => wss.close(() => server.close(r)));
  }
}

test('POST /session returns 401 without the auth secret', { timeout: 10000 }, async () => {
  await withServer(async (port) => {
    try {
      const b = await postSession(port, 'wrong-secret');
      assert.fail('expected rejection, got ' + JSON.stringify(b));
    } catch (e) {
      assert.match(e.message, /unauthorized/);
    }
  });
});

test('POST /session issues an isolated workspace + token', { timeout: 10000 }, async () => {
  await withServer(async (port) => {
    const s = await postSession(port);
    assert.equal(s.ok, true);
    assert.match(s.token, /^[0-9a-f]+$/);
    assert.ok(s.workspace.includes('.sessions'));
  });
});

test('WSS rejects a connection without a token', { timeout: 10000 }, async () => {
  await withServer(async (port) => {
    const ws = new WebSocket(`wss://localhost:${port}/ws`, { rejectUnauthorized: false });
    const outcome = await new Promise((resolve) => {
      ws.on('message', (b) => {
        const f = JSON.parse(b.toString());
        if (f.type === 'error') resolve({ error: new Error(f.message) });
      });
      ws.on('close', () => resolve({ closed: true }));
      ws.on('error', () => resolve({ closed: true }));
    });
    assert.ok(outcome.error || outcome.closed, 'connection must be rejected');
    if (outcome.error) assert.match(outcome.error.message, /unauthorized/);
    ws.close();
  });
});

test('WSS unified session: call read_file over one socket', { timeout: 10000 }, async () => {
  await withServer(async (port) => {
    const { token } = await postSession(port);
    const ws = await openSession(port, token);
    try {
      const w = await callTool(ws, 'write_file', { path: 'doc.txt', content: 'inverse of kimi\n' }, 1);
      assert.equal(w.ok, true);
      const out = await callTool(ws, 'read_file', { path: 'doc.txt' }, 2);
      assert.equal(out.ok, true);
      assert.match(out.result, /inverse of kimi/);
    } finally {
      ws.close();
    }
  });
});

test('WSS unified session: write_file then read_file in isolated workspace', { timeout: 10000 }, async () => {
  await withServer(async (port) => {
    const { token } = await postSession(port);
    const ws = await openSession(port, token);
    try {
      const w = await callTool(ws, 'write_file', { path: 'sub/x.txt', content: ' via wss\n' }, 1);
      assert.equal(w.ok, true);
      const r = await callTool(ws, 'read_file', { path: 'sub/x.txt' }, 2);
      assert.equal(r.ok, true);
      assert.equal(r.result, ' via wss\n');
    } finally {
      ws.close();
    }
  });
});

test('WSS exec streams stdout + exit inside the session workspace', { timeout: 10000 }, async () => {
  await withServer(async (port) => {
    const { token } = await postSession(port);
    const ws = await openSession(port, token);
    try {
      const { code, output } = await streamExec(ws, 'echo wss-stream-ok');
      assert.equal(code, 0);
      assert.match(output, /wss-stream-ok/);
    } finally {
      ws.close();
    }
  });
});

test('two agent sessions are isolated (same path, different content)', { timeout: 10000 }, async () => {
  await withServer(async (port) => {
    const a = await postSession(port);
    const b = await postSession(port);
    const wsA = await openSession(port, a.token);
    const wsB = await openSession(port, b.token);
    try {
      await callTool(wsA, 'write_file', { path: 'shared.txt', content: 'A\n' }, 1);
      await callTool(wsB, 'write_file', { path: 'shared.txt', content: 'B\n' }, 1);

      const ra = await callTool(wsA, 'read_file', { path: 'shared.txt' }, 2);
      const rb = await callTool(wsB, 'read_file', { path: 'shared.txt' }, 2);

      assert.equal(ra.result, 'A\n');
      assert.equal(rb.result, 'B\n');
    } finally {
      wsA.close();
      wsB.close();
    }
  });
});

test('transcript records each tool call as a kimi command', { timeout: 10000 }, async () => {
  await withServer(async (port) => {
    const unauth = await getTranscript(port, 'x', 'wrong-secret');
    assert.equal(unauth.ok, false);
    assert.match(unauth.error, /unauthorized/);

    const s = await postSession(port);
    const ws = await openSession(port, s.token);
    try {
      await callTool(ws, 'write_file', { path: 't.txt', content: 'hi\n' }, 1);
      await callTool(ws, 'read_file', { path: 't.txt' }, 2);
      await streamExec(ws, 'echo recorded');
      const tr = await getTranscript(port, s.sessionId);
      assert.equal(tr.ok, true);
      const kimi = tr.entries.map((e) => e.kimi);
      assert.ok(kimi.includes('Write'), 'transcript missing Write');
      assert.ok(kimi.includes('Read'), 'transcript missing Read');
      assert.ok(kimi.includes('Bash'), 'transcript missing Bash');
      const bash = tr.entries.find((e) => e.kimi === 'Bash');
      assert.equal(bash.exitCode, 0);
    } finally {
      ws.close();
    }
  });
});
