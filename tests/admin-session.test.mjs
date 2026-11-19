import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSession, getSessionState, refreshSession, login, logout, changePassword, readDataFile, writeDataFile, commitFiles } from '../src/lib/server-admin.js';

function mockApi(t, replies) {
  clearSession();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    const next = replies.shift();
    assert.ok(next, `unexpected API call ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

test('login obtains an anonymous CSRF token and uses same-origin cookies without GitHub authorization', async t => {
  const calls = mockApi(t, [
    { body: { authenticated: false, user: null, csrf: 'anonymous' } },
    { body: { authenticated: true, user: { username: 'editor', name: 'Редактор' }, csrf: 'signed-in' } },
  ]);
  await login('editor', 'a real user password', 'captcha-token');
  assert.equal(calls[0].url, '/api/admin.php?action=session');
  assert.equal(calls[1].url, '/api/admin.php?action=login');
  assert.equal(calls[1].headers['X-CSRF-Token'], 'anonymous');
  assert.deepEqual(JSON.parse(calls[1].body), { username: 'editor', password: 'a real user password', captchaToken: 'captcha-token' });
  for (const call of calls) {
    assert.equal(call.credentials, 'same-origin');
    assert.equal(call.cache, 'no-store');
    assert.equal(call.headers.Authorization, undefined);
  }
  assert.equal(getSessionState().csrf, 'signed-in');
  assert.equal(getSessionState().authenticated, true);
});

test('data writes preserve expected SHA and surface conflicts without replaying a commit', async t => {
  const calls = mockApi(t, [
    { body: { authenticated: true, user: { username: 'editor' }, csrf: 'csrf' } },
    { status: 409, body: { error: 'conflict', message: 'conflict' } },
  ]);
  await refreshSession();
  await assert.rejects(writeDataFile('news.json', [{ title: 'Русский текст' }], 'original-sha', 'Правка'), error => error.status === 409 && /не перезаписаны/.test(error.message));
  assert.equal(calls.length, 2);
  const payload = JSON.parse(calls[1].body);
  assert.equal(payload.files[0].expectedSha, 'original-sha');
  assert.equal(payload.files[0].path, 'src/data/news.json');
  assert.deepEqual(JSON.parse(payload.files[0].text), [{ title: 'Русский текст' }]);
});

test('expired sessions remove authentication and reads preserve an optional snapshot ref', async t => {
  const calls = mockApi(t, [
    { body: { authenticated: true, user: { username: 'editor' }, csrf: 'csrf' } },
    { status: 401, body: { error: 'unauthorized', message: 'Войдите снова' } },
  ]);
  await refreshSession();
  await assert.rejects(readDataFile('houses.json', 'a/b'), error => error.status === 401);
  assert.match(calls[1].url, /file=houses.json&ref=a%2Fb$/);
  assert.equal(getSessionState().authenticated, false);
  assert.equal(getSessionState().user, null);
});

test('password and logout use rotated CSRF tokens; logout clears local session state', async t => {
  const calls = mockApi(t, [
    { body: { authenticated: true, user: { username: 'editor' }, csrf: 'first' } },
    { body: { authenticated: true, user: { username: 'editor' }, csrf: 'second' } },
    { body: { authenticated: false, user: null, csrf: 'third' } },
  ]);
  await refreshSession();
  await changePassword('old password', 'new password long enough');
  await logout();
  assert.equal(calls[1].headers['X-CSRF-Token'], 'first');
  assert.equal(calls[2].headers['X-CSRF-Token'], 'second');
  assert.deepEqual(JSON.parse(calls[1].body), { currentPassword: 'old password', newPassword: 'new password long enough' });
  assert.deepEqual(getSessionState(), { authenticated: false, user: null, csrf: '' });
});

test('403 clears stale CSRF without automatically retrying state-changing requests', async t => {
  const calls = mockApi(t, [
    { body: { authenticated: true, user: { username: 'editor' }, csrf: 'old' } },
    { status: 403, body: { error: 'csrf', message: 'Обновите страницу' } },
  ]);
  await refreshSession();
  await assert.rejects(changePassword('old', 'new'), error => error.status === 403);
  assert.equal(calls.length, 2);
  assert.equal(getSessionState().csrf, '');
});

test('unsafe paths and missing snapshots are rejected before any request', t => {
  const calls = mockApi(t, []);
  assert.throws(() => readDataFile('../users.json'));
  assert.throws(() => writeDataFile('news.json', [], '', 'edit'));
  assert.throws(() => commitFiles([{ path: 'public/api/admin.php', text: 'bad' }], 'edit'));
  assert.throws(() => commitFiles([{ path: 'src/data/news.json', text: '[]' }], 'edit'));
  assert.throws(() => commitFiles([{ path: 'public/documents/report.pdf', text: '', base64: '' }], 'edit'));
  assert.equal(calls.length, 0);
});
