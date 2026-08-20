// mcp-client.mjs — a minimal MCP-over-SSE client for miki.
//
// This is the stand-in for a real LLM-driven cloud agent (the surgeon). It does
// NOT carry a provider and does NOT think — it just speaks MCP to miki and shows
// the arms performing kimi commands inside the box. A real agent plugs in the
// same way: open SSE, initialize, list tools, call them.
//
//   node mcp-client.mjs "echo hello from the surgeon"   (runs an exec)
//   node mcp-client.mjs                                 (lists tools + reads sample.txt)

import https from 'node:https';
import { randomUUID } from 'node:crypto';

const BASE = process.env.MIKI_BASE || 'https://localhost:7654';
const AUTH = process.env.MIKI_AUTH_SECRET || 'dev-secret-change-me';
const agent = new https.Agent({ rejectUnauthorized: false });

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(
      BASE + pathname,
      { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + AUTH }, agent },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  // 1. get a session token (the surgeon's identity in the box)
  const session = await req('POST', '/session');
  if (!session.body?.ok) {
    console.error('could not get session:', session.body);
    process.exit(1);
  }
  const token = session.body.token;
  const wsBase = BASE.replace('https://', 'wss://');

  // 2. open the SSE stream (server -> client) and read the endpoint event
  const sse = https.get(
    BASE + '/mcp?token=' + token,
    { headers: { accept: 'text/event-stream', authorization: 'Bearer ' + token }, agent },
  );
  let postUrl = null;
  const pending = new Map();
  let buffer = '';
  sse.on('data', (c) => {
    buffer += c.toString();
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = /event: (\S+)/.exec(chunk);
      const data = /data: (.+)/.exec(chunk);
      if (!data) continue;
      // The `endpoint` event carries a URL string, not JSON-RPC — capture it
      // first so we know where to POST, before any JSON parsing happens.
      if (ev && ev[1] === 'endpoint') {
        postUrl = BASE + data[1];
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
        process.stdout.write(payload.params.message);
      }
    }
  });

  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = randomUUID();
      pending.set(id, resolve);
      https.request(
        postUrl,
        { method: 'POST', headers: { 'content-type': 'application/json' }, agent },
        (res) => res.resume(),
      )
        .on('error', (e) => {
          throw e;
        })
        .end(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });

  // wait for the endpoint event
  while (!postUrl) await new Promise((r) => setTimeout(r, 20));

  // 3. initialize + list tools
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'miki-demo', version: '0' } });
  const listed = await rpc('tools/list');
  console.log('miki MCP tools:');
  for (const t of listed.result.tools) {
    console.log(`  - ${t.name}  (kimi: ${t.description.match(/kimi: (\w+)/)?.[1]})`);
  }

  // 4. call a read tool, then exec (streaming). The agent's box starts empty,
  //    so write first, then read it back — proves the round-trip through MCP.
  await rpc('tools/call', { name: 'write_file', arguments: { path: 'miki-hello.txt', content: 'surgeon was here\n' } });
  const read = await rpc('tools/call', { name: 'read_file', arguments: { path: 'miki-hello.txt' } });
  console.log('\nread_file ->', JSON.stringify(read.result.content[0].text).slice(0, 80));

  const cmd = process.argv[2] || 'echo surgeon-online';
  console.log(`\nexec: ${cmd}`);
  const exec = await rpc('tools/call', { name: 'exec', arguments: { command: cmd } });
  console.log('\nexec done, exit captured:', exec.result.isError === false);
  sse.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
