import test from 'node:test';
import assert from 'node:assert/strict';
import { commitFiles, checkToken, writeDataFile, setToken } from '../src/lib/github-admin.js';

function mock(t, responder) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const call = { path: new URL(url).pathname, query: new URL(url).search, method: options.method || 'GET', body: options.body && JSON.parse(options.body) };
    calls.push(call);
    const result = responder(call, calls);
    return { status: result.status || 200, ok: !result.status || result.status < 400, json: async () => result.data };
  };
  t.after(() => { globalThis.fetch = original; });
  setToken('test-token');
  return calls;
}
test('stale multi-file JSON is rejected before creating blobs or updating refs', async t => {
  const calls = mock(t, call => ({ data: call.path.includes('/git/ref/') ? { object: { sha: 'head' } } : { sha: 'new-version', content: btoa('[]') } }));
  await assert.rejects(commitFiles([{ path: 'src/data/houses.json', text: '[]', expectedSha: 'old-version' }], 'test'), /Данные изменились/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].query, '?ref=head');
  assert.ok(calls.every(x => x.method === 'GET'));
});
test('atomic commit uses actual parent tree and explicitly refuses forced updates', async t => {
  const calls = mock(t, c => {
    if (c.path.includes('/git/ref/')) return { data: { object: { sha: 'head' } } };
    if (c.path.includes('/contents/')) return { data: { sha: 'original', content: btoa('[]') } };
    if (c.path.endsWith('/git/commits/head')) return { data: { tree: { sha: 'tree-base' } } };
    if (c.path.endsWith('/git/blobs')) return { data: { sha: 'blob' } };
    if (c.path.endsWith('/git/trees')) return { data: { sha: 'new-tree' } };
    if (c.path.endsWith('/git/commits')) return { data: { sha: 'new-head' } };
    return { data: {} };
  });
  await commitFiles([{ path: 'src/data/houses.json', text: '[]', expectedSha: 'original' }], 'test');
  assert.equal(calls.find(x => x.path.endsWith('/git/trees')).body.base_tree, 'tree-base');
  assert.deepEqual(calls.at(-1).body, { sha: 'new-head', force: false });
});
test('read-only token is rejected and content update preserves expected SHA', async t => {
  const calls = mock(t, () => ({ data: { permissions: { push: false } } }));
  await assert.rejects(checkToken(), /права записи/);
  await writeDataFile('news.json', [{ title: 'Тест' }], 'expected-sha', 'test');
  assert.equal(calls.at(-1).body.sha, 'expected-sha');
});
