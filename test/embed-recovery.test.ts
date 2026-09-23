import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/db/index.ts';
import { embedMissing, type ProgressEvent } from '../src/index/embed.ts';

const cfg = { model: 'text-embedding-3-small', dimensions: 2, apiKey: 'test-only' };
function fixture(t: any, texts: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'archive.db');
  const db = openStore(path);
  db.prepare(`INSERT INTO threads (id, kind, first_seen_at, last_seen_at)
              VALUES ('chat', 'dm', 0, 0)`).run();
  const ins = db.prepare(`INSERT INTO windows
    (thread_id, start_ts, end_ts, msg_count, text, content_hash)
    VALUES ('chat', 0, 1, 1, ?, ?)`);
  texts.forEach((text, i) => ins.run(text, String(i).padStart(3, '0')));
  db.close();
  return path;
}
const tooLong = () => new Response(JSON.stringify({ error: {
  type: 'invalid_request_error',
  message: "Invalid 'input[1]': maximum input length is 8192 tokens.",
} }), { status: 400 });
const success = (texts: string[]) => new Response(JSON.stringify({
  // Reverse response order to also exercise vector-to-input mapping.
  data: texts.map((text, index) => ({ index, embedding: text === 'good-b' ? [0, 1] : [1, 0] })).reverse(),
  usage: { total_tokens: texts.length * 3 },
}));

test('isolates multiple oversized windows, saves good vectors, retries only pending windows', async t => {
  const path = fixture(t, ['good-a', 'bad-1', 'good-b', 'bad-2', 'good-c']);
  let reject = true;
  const calls: string[][] = [];
  const events: ProgressEvent[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: any) => {
    const texts = JSON.parse(init.body).input as string[];
    calls.push(texts);
    return reject && texts.some(s => s.startsWith('bad')) ? tooLong() : success(texts);
  });
  const first = await embedMissing(path, cfg, { batchSize: 4, onProgress: e => events.push(e) });
  assert.equal(first.embedded, 3);
  assert.equal(first.failed, 2);
  assert.equal(first.pending, 2);
  assert.equal(first.tokens, 9);
  assert.equal(events.filter(e => e.phase === 'warn' && e.code === 'input_too_long').length, 2);
  const db = openStore(path);
  const vectors = db.prepare('SELECT content_hash, vec FROM window_vectors ORDER BY content_hash').all() as any[];
  assert.deepEqual(vectors.map(v => v.content_hash), ['000', '002', '004']);
  assert.deepEqual(vectors.map(v => [...new Float32Array(Uint8Array.from(v.vec).buffer)]), [[1,0], [0,1], [1,0]]);
  db.close();
  calls.length = 0;
  reject = false;
  const second = await embedMissing(path, cfg);
  assert.deepEqual(calls.flat(), ['bad-1', 'bad-2']);
  assert.equal(second.embedded, 2);
  assert.equal(second.pending, 0);
  assert.equal(second.failed, 0);
  calls.length = 0;
  assert.equal((await embedMissing(path, cfg)).embedded, 0);
  assert.equal(calls.length, 0);
});

test('all oversized windows remain pending on subsequent runs', async t => {
  const path = fixture(t, ['bad-1', 'bad-2']);
  t.mock.method(globalThis, 'fetch', async () => tooLong());
  for (let i = 0; i < 2; i++) {
    const result = await embedMissing(path, cfg);
    assert.equal(result.failed, 2);
    assert.equal(result.embedded, 0);
    assert.equal(result.pending, 2);
  }
});

for (const status of [400, 401]) {
  test(`unrelated HTTP ${status} errors stop without discarding saved progress`, async t => {
    const path = fixture(t, ['good-a', 'good-b']);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: any) => {
      if (++calls === 1) return success(JSON.parse(init.body).input);
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid model' } }), { status });
    });
    await assert.rejects(embedMissing(path, cfg, { batchSize: 1 }), new RegExp(String(status)));
    assert.equal(calls, 2);
    const db = openStore(path);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM window_vectors').get() as any).c, 1);
    db.close();
  });
}

test('cancellation stops subdivision instead of marking a window as failed', async t => {
  const path = fixture(t, ['bad-1', 'bad-2']);
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    controller.abort();
    return tooLong();
  });
  await assert.rejects(embedMissing(path, cfg, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
