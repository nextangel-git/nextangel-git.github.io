import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import bcrypt from '../admin/node_modules/bcryptjs/index.js';

test('isolated admin: login, CSRF, metadata preservation, stale edits and uploads', { timeout: 20000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jks-admin-test-'));
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir);
  const news = [{ id: 123, slug: 'stable-slug', title: 'Old', date: '19.11.2026', body: 'Text', attachments: ['keep'] }];
  const datasets = { news, houses: [], houses_geo: [], competitors: [], documents: [], shutdowns: [], faq: [], useful: {}, services: [], requests: [], vk_posts: [] };
  for (const [name, data] of Object.entries(datasets)) await fs.writeFile(path.join(dataDir, name + '.json'), JSON.stringify(data));
  const password = 'test-only-' + crypto.randomUUID();
  await fs.writeFile(path.join(dir, 'users.json'), JSON.stringify([{ login: 'test', name: 'Test', role: 'admin', passHash: bcrypt.hashSync(password, 4) }]));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['admin/server.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'test', JKS_ADMIN_TEST_DIR: dir, HOST: '127.0.0.1', PORT: String(port), GIT_PUSH: '0', REBUILD: '0' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => { child.kill(); await once(child, 'exit').catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  let cookie = '';
  const base = `http://127.0.0.1:${port}`;
  async function request(url, init = {}) {
    const res = await fetch(base + url, { ...init, redirect: 'manual', headers: { cookie, ...init.headers } });
    for (const c of res.headers.getSetCookie()) cookie = c.split(';')[0];
    return res;
  }
  for (let i = 0; !output.includes('Админка ЖКС:') && i < 100; i++) { if (child.exitCode !== null) throw new Error(output); await new Promise(r => setTimeout(r, 30)); }
  assert.match(output, /Админка ЖКС:/);
  const login = await request('/login'); const html = await login.text();
  const csrf = html.match(/name="__csrf" value="([^"]+)"/)[1];
  const captcha = output.match(/\[test\] captcha: (\S+)/)[1];
  const oldCookie = cookie;
  let res = await request('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ login: 'test', password, captcha, __csrf: csrf }) });
  assert.equal(res.headers.get('location'), '/'); assert.notEqual(cookie, oldCookie);
  res = await request('/c/news/edit/0'); const edit = await res.text();
  assert.equal(res.status, 200);
  const token = edit.match(/name="__csrf" value="([^"]+)"/)[1];
  const revision = edit.match(/name="__revision" value="([^"]+)"/)[1];
  const makeBody = () => { const fd = new FormData(); for (const [key, val] of Object.entries({ __csrf: token, __revision: revision, title: 'Changed', date: '19.11.2026', body: 'New text' })) fd.set(key, val); return fd; };
  res = await request('/c/news/save/0', { method: 'POST', headers: { Origin: 'https://attacker.invalid' }, body: makeBody() }); assert.equal(res.status, 403);
  const noCsrf = makeBody(); noCsrf.delete('__csrf');
  res = await request('/c/news/save/0', { method: 'POST', body: noCsrf }); assert.equal(res.status, 403);
  res = await request('/c/news/save/0', { method: 'POST', body: makeBody() }); assert.equal(res.status, 302);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'news.json'), 'utf8'))[0];
  assert.equal(saved.id, 123); assert.equal(saved.slug, 'stable-slug'); assert.deepEqual(saved.attachments, ['keep']); assert.equal(saved.title, 'Changed');
  res = await request('/c/news/save/0', { method: 'POST', body: makeBody() }); assert.equal(res.status, 409);
  res = await request('/c/documents/edit/new'); const docHtml = await res.text();
  const fd = new FormData(); fd.set('__csrf', token); fd.set('__revision', docHtml.match(/name="__revision" value="([^"]+)"/)[1]); fd.set('__file', new Blob(['<script>alert(1)</script>']), 'evil.html');
  res = await request('/c/documents/save/new', { method: 'POST', body: fd }); assert.ok(res.status >= 400);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'documents.json'), 'utf8')), []);
  assert.ok(!output.includes('git push'));
});
