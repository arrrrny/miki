// mcp.mjs — miki as an MCP server (Model Context Protocol), over SSE.
//
// The cloud agent (surgeon) already speaks MCP. Instead of inventing a new wire,
// miki exposes its existing arms — every tool already tagged with its kimi
// mapping in server.mjs — as MCP tools. The surgeon plugs in over the protocol
// it knows; the arms perform each call inside the box as if kimi itself issued
// the kimi command. Same tools, same isolation, same transcript audit.
//
// Transport: MCP-over-SSE (the r2.sh model — HTTPS + server push).
//   GET  /mcp  -> SSE stream: server->client messages + an `endpoint` event
//                  telling the client where to POST (the client->server channel).
//   POST /mcp?sessionId=<id> -> JSON-RPC 2.0 from client; response is written
//                  back over the matching SSE stream.
//
// Each client authenticates with its session token (?token= on the SSE GET, or
// Authorization: Bearer on POST), so the arms stay confined to the agent's
// isolated workspace — exactly like the WSS session.

import crypto from 'node:crypto';

function jsonRpc(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// miki tool -> MCP tool schema. Every miki tool declares `input` as
// { arg: 'description' }; we surface that as a JSON-Schema object so the
// surgeon's client renders a real tool with real parameters.
function toMcpTool(name, t) {
  const props = {};
  const required = [];
  for (const [arg, desc] of Object.entries(t.input || {})) {
    props[arg] = { type: 'string', description: String(desc) };
    if (!String(desc).includes('?')) required.push(arg);
  }
  const dangerous = name === 'exec' || name === 'write_file' || name === 'edit' || name === 'multiedit';
  return {
    name,
    description: t.description + ` (kimi: ${t.kimi})`,
    inputSchema: { type: 'object', properties: props, required },
    annotations: {
      title: `miki/${name}`,
      readOnlyHint: !dangerous,
      destructiveHint: dangerous,
      openWorldHint: name === 'exec' || name === 'grep',
      idempotentHint: name === 'read_file' || name === 'list_files' || name === 'grep',
    },
  };
}

export function attachMcp(server, { tools, invokeTool, runExec, sessionForToken }) {
  // token -> { res, mcpSessionId }. Keyed by the miki session token; the SSE
  // GET carries it, so the client->server POST (with mcpSessionId) resolves
  // back to the same agent's isolated workspace.
  const sseClients = new Map();

  function writeSse(res, obj) {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  async function handleMessage(client, msg) {
    const sid = msg.id ?? null;
    const reply = (obj) => client && writeSse(client.res, obj);
    const sess = sessionForToken(client.token);
    const auditId = sess ? sess.id : null;
    const root = sess ? sess.workspace : undefined;

    if (msg.method === 'initialize') {
      return reply(
        jsonRpc(sid, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'miki', version: '0.1.0' },
        }),
      );
    }
    if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
      return; // no response for notifications
    }
    if (msg.method === 'tools/list') {
      return reply(jsonRpc(sid, { tools: Object.entries(tools).map(([n, t]) => toMcpTool(n, t)) }));
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      if (!sess) {
        return reply(jsonRpcError(sid, -32001, 'unknown or missing session token'));
      }
      // exec streams: spool each chunk as an MCP progress notification, then
      // resolve with the full capture. The surgeon watches the arms work live.
      if (name === 'exec') {
        const { promise } = runExec({
          command: args.command,
          root,
          cwd: args.cwd,
          timeout: args.timeout,
          sessionId: auditId,
          onProgress: (f) => {
            if (f.type === 'stdout' || f.type === 'stderr') {
              reply({ jsonrpc: '2.0', method: 'notification/progress', params: { progressToken: sid, message: f.data } });
            }
          },
        });
        const r = await promise;
        return reply(jsonRpc(sid, { content: [{ type: 'text', text: r.result ?? '' }], isError: false }));
      }
      const out = await invokeTool(name, args, root, auditId, 'mcp');
      return reply(
        jsonRpc(sid, {
          content: [{ type: 'text', text: out.ok ? String(out.result) : `error: ${out.error}` }],
          isError: !out.ok,
        }),
      );
    }
    if (sid !== null) reply(jsonRpcError(sid, -32601, `method not found: ${msg.method}`));
  }

  function handler(req, res) {
    const url = new URL(req.url, 'https://localhost');

    // SSE stream (server -> client) + endpoint event (client -> server URL).
    if (req.method === 'GET' && url.pathname === '/mcp') {
      const auth = req.headers['authorization'] || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const token = bearer || url.searchParams.get('token') || '';
      const sess = sessionForToken(token);
      if (!sess) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized — expected ?token=<token>' }));
        return;
      }
      const mcpSessionId = crypto.randomUUID();
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      sseClients.set(mcpSessionId, { res, token });
      res.write(`event: endpoint\ndata: /mcp?sessionId=${mcpSessionId}\n\n`);
      req.on('close', () => sseClients.delete(mcpSessionId));
      return;
    }

    // JSON-RPC from client -> routed to the matching SSE stream.
    if (req.method === 'POST' && url.pathname === '/mcp') {
      const mcpSessionId = url.searchParams.get('sessionId');
      const client = sseClients.get(mcpSessionId);
      if (!client) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no SSE stream for sessionId' }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        let msg;
        try {
          msg = JSON.parse(body || '{}');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        try {
          await handleMessage(client, msg);
        } catch (e) {
          writeSse(client.res, jsonRpcError(msg.id ?? null, -32603, String(e && e.message ? e.message : e)));
        }
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  }

  return { handler, sseClients };
}
