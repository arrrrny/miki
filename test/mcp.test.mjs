import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server.mjs';

function makeAgent() {
  return new https.Agent({ rejectUnauthorized: false });
}

function startServer() {
  const { server, wss } = createServer();
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, wss, port: server.address().port }));
  });
}

function newSession(base, agent) {
  return new Promise((res) =>
    https
      .request(`${base}/session`, { method: 'POST', headers: { authorization: 'Bearer dev-secret-change-me' }, agent }, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => res(JSON.parse(b)));
      })
      .end(),
  );
}

// Minimal MCP-over-SSE client: opens SSE, captures the POST url + progress
// stream, and sends JSON-RPC requests. Returns { rpc, progress }.
function mcpClient(base, token, agent) {
  return new Promise((resolve) => {
    let postUrl = null;
    const pending = new Map();
    const progress = [];
    let buf = '';
    const sse = https.get(
      `${base}/mcp?token=${token}`,
      { headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` }, agent },
      (res) => {
        res.on('error', (e) => console.log('mcpClient SSE res error', e.message));
        res.on('data', (c) => {
          buf += c.toString();
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = /event: (\S+)/.exec(chunk);
            const data = /data: (.+)/.exec(chunk);
            if (!data) continue;
            if (ev && ev[1] === 'endpoint') {
              postUrl = `${base}${data[1]}`;
              resolve({ rpc, progress, close: () => { sse.destroy(); agent.destroy(); } });
              continue;
            }
            let payload;
            try {
              payload = JSON.parse(data[1]);
            } catch {
              continue;
            }
            if (payload.id != null && pending.has(payload.id)) {
              pending.get(payload.id)(payload);
              pending.delete(payload.id);
            } else if (payload.method === 'notification/progress') {
              progress.push(payload.params.message);
            }
          }
        });
      },
    );
    function rpc(method, params) {
      return new Promise((res) => {
        const id = randomUUID();
        pending.set(id, res);
        const r = https.request(
          postUrl,
          { method: 'POST', headers: { 'content-type': 'application/json' }, agent },
          (rr) => rr.resume(),
        );
        r.on('error', () => {});
        r.end(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    }
    const wait = async () => {
      for (let i = 0; i < 150 && !postUrl; i++) await new Promise((r) => setTimeout(r, 20));
      if (!postUrl) throw new Error('mcpClient: no endpoint event — SSE handshake stalled');
    };
    const guard = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('mcpClient: no endpoint event within 3s — SSE handshake stalled')), 3000),
    );
    return Promise.race([wait(), guard]);
  });
}

test('mcp: initialize + tools/list exposes every arm with its kimi mapping', async (t) => {
  const { server, wss, port } = await startServer();
  const agent = makeAgent();
  const base = `https://localhost:${port}`;
  const sess = await newSession(base, agent);
  const { rpc, close } = await mcpClient(base, sess.token, agent);
  t.after(() => {
    try { close(); } finally { try { wss.close(); } finally { server.close(); } }
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {} });
  const list = await rpc('tools/list');
  const names = list.result.tools.map((x) => x.name);
  for (const want of ['read_file', 'write_file', 'edit', 'multiedit', 'grep', 'list_files', 'exec']) {
    assert.ok(names.includes(want), `missing MCP tool: ${want}`);
  }
  const read = list.result.tools.find((x) => x.name === 'read_file');
  assert.match(read.description, /kimi: Read/);
  assert.equal(read.annotations.readOnlyHint, true);
  const exec = list.result.tools.find((x) => x.name === 'exec');
  assert.equal(exec.annotations.destructiveHint, true);
  assert.equal(exec.annotations.openWorldHint, true);
});

test('mcp: tools/call write_file then read_file round-trips in the box', async (t) => {
  const { server, wss, port } = await startServer();
  const agent = makeAgent();
  const base = `https://localhost:${port}`;
  const sess = await newSession(base, agent);
  const { rpc, close } = await mcpClient(base, sess.token, agent);
  t.after(() => {
    try { close(); } finally { try { wss.close(); } finally { server.close(); } }
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {} });
  const w = await rpc('tools/call', { name: 'write_file', arguments: { path: 'miki-mcp.txt', content: 'inverse kimi round-trip\n' } });
  assert.equal(w.result.isError, false);
  const out = await rpc('tools/call', { name: 'read_file', arguments: { path: 'miki-mcp.txt' } });
  assert.equal(out.result.isError, false);
  assert.match(out.result.content[0].text, /inverse kimi round-trip/);
});

test('mcp: exec streams progress and returns captured output', async (t) => {
  const { server, wss, port } = await startServer();
  const agent = makeAgent();
  const base = `https://localhost:${port}`;
  const sess = await newSession(base, agent);
  const { rpc, progress, close } = await mcpClient(base, sess.token, agent);
  t.after(() => {
    try { close(); } finally { try { wss.close(); } finally { server.close(); } }
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {} });
  const out = await rpc('tools/call', { name: 'exec', arguments: { command: 'echo streamed' } });
  assert.equal(out.result.isError, false);
  assert.match(out.result.content[0].text, /streamed/);
  assert.ok(progress.length > 0, 'exec should have streamed progress notifications');
  assert.match(progress.join(''), /streamed/);
});
