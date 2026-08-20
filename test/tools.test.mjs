import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeTool, tools } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

test('tool registry maps every tool to a kimi command', () => {
  for (const [name, t] of Object.entries(tools)) {
    assert.ok(t.kimi, `${name} missing kimi mapping`);
    assert.ok(t.transport, `${name} missing transport`);
  }
  assert.equal(tools.read_file.kimi, 'Read');
  assert.equal(tools.write_file.kimi, 'Write');
  assert.equal(tools.list_files.kimi, 'Glob');
  assert.equal(tools.exec.kimi, 'Bash');
});

test('read_file returns file contents', async () => {
  const out = await invokeTool('read_file', { path: 'sample.txt' });
  assert.equal(out.ok, true);
  assert.match(out.result, /inverse of kimi/);
});

test('read_file rejects path escape', async () => {
  const out = await invokeTool('read_file', { path: '../../etc/hostname' });
  assert.equal(out.ok, false);
  assert.match(out.error, /escapes sandbox root/);
});

test('write_file then read_file round-trips', async () => {
  const p = 'test/_tmp_write.txt';
  const content = 'hello miki\n';
  const w = await invokeTool('write_file', { path: p, content });
  assert.equal(w.ok, true);
  const r = await invokeTool('read_file', { path: p });
  assert.equal(r.ok, true);
  assert.equal(r.result, content);
  await fs.rm(path.join(ROOT, p), { force: true });
});

test('list_files returns entries', async () => {
  const out = await invokeTool('list_files', { pattern: '*.mjs' });
  assert.equal(out.ok, true);
  assert.match(out.result, /server\.mjs/);
});

test('exec is rejected over REST (it is a WSS streaming tool)', async () => {
  const out = await invokeTool('exec', { command: 'echo hi' });
  assert.equal(out.ok, false);
  assert.match(out.error, /WSS/);
});

test('unknown tool errors', async () => {
  const out = await invokeTool('nope', {});
  assert.equal(out.ok, false);
  assert.match(out.error, /unknown tool/);
});
