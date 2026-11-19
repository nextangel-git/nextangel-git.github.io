import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const php = process.env.PHP_BIN || 'php';
const available = spawnSync(php, ['-v'], { windowsHide: true }).status === 0;

test('PHP schema and atomic GitHub commit regression tests', { skip: !available && 'Set PHP_BIN to a PHP 7.4+ executable' }, () => {
  const result = spawnSync(php, ['tests/admin-php-unit.php'], { cwd: root, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.ok(report.passed >= 30);
  assert.equal(report.network_used, false);
});

test('PHP commit memory increases only insufficient limits and reports restricted hosting', { skip: !available && 'Set PHP_BIN' }, () => {
  const code = 'require "public/api/admin-core.php"; try { JksAdminApi::prepareCommitMemory(); echo ini_get("memory_limit"); } catch (JksApiError $e) { echo $e->status . ":" . $e->errorCode; }';
  for (const [initial, expected, extra] of [['64M','256M',[]], ['512M','512M',[]], ['-1','-1',[]], ['64M','503:upload_memory_limit',['-d','disable_functions=ini_set']]]) {
    const result=spawnSync(php,['-d','memory_limit='+initial,...extra,'-r',code],{cwd:root,windowsHide:true,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,expected);
  }
});

test('PHP provisioning uses stdin, hashes passwords, refuses overwrite and public output', { skip: !available && 'Set PHP_BIN' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jks-php-provision-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, '.jks-admin', 'config.php');
  const password = 'test-' + crypto.randomUUID();
  const token = 'TEST_ONLY_NO_NETWORK_' + crypto.randomUUID();
  const input = JSON.stringify({ username: 'testadmin', name: 'Test', password, github_token: token });
  const provision = output => spawnSync(php, ['admin/provision-php.php', '--output=' + output, '--stdin'], { cwd: root, input, encoding: 'utf8', windowsHide: true });
  const result = provision(destination);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.created, true); assert.equal(report.uploaded, false);
  assert.ok(!result.stdout.includes(password)); assert.ok(!result.stdout.includes(token));
  const config = await fs.readFile(destination, 'utf8');
  assert.ok(!config.includes(password)); assert.ok(config.includes('password_hash'));
  const verify = spawnSync(php, ['-r', '$c=require $argv[1]; exit(password_verify($argv[2],$c["users"]["testadmin"]["password_hash"])?0:1);', destination, password], { encoding: 'utf8', windowsHide: true });
  assert.equal(verify.status, 0, verify.stderr);
  assert.notEqual(provision(destination).status, 0);
  assert.equal(await fs.readFile(destination, 'utf8'), config);
  assert.notEqual(provision(path.join(root, 'public', 'config.php')).status, 0);
  // Run unsafe destination checks in a disposable copy, never in a deployment artifact.
  const fixtureRoot = path.join(directory, 'fixture');
  await fs.mkdir(path.join(fixtureRoot, 'admin'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'public', 'api'), { recursive: true });
  await fs.copyFile(path.join(root, 'admin', 'provision-php.php'), path.join(fixtureRoot, 'admin', 'provision-php.php'));
  await fs.copyFile(path.join(root, 'public', 'api', 'admin-schema.php'), path.join(fixtureRoot, 'public', 'api', 'admin-schema.php'));
  for (const unsafe of [path.join(fixtureRoot, 'dist', '.jks-admin', 'config.php'), path.join(fixtureRoot, 'public', '.jks-admin', 'config.php'), '/home/jksooo/jks.ooo/docs/.jks-admin/config.php']) {
    const rejected = spawnSync(php, ['admin/provision-php.php', '--output=' + unsafe, '--stdin'], { cwd: fixtureRoot, input, encoding: 'utf8', windowsHide: true });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /webroot/);
  }
  await assert.rejects(fs.access(path.join(fixtureRoot, 'dist')));
});

test('PHP sessions, login, CSRF, password rotation, rate limits and missing configuration', { skip: !available && 'Set PHP_BIN', timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jks-php-admin-'));
  const password = 'test-only-' + crypto.randomUUID();
  const newPassword = 'changed-only-' + crypto.randomUUID();
  const hashed = spawnSync(php, ['-r', 'echo password_hash($argv[1], PASSWORD_BCRYPT, ["cost"=>4]);', password], { encoding: 'utf8', windowsHide: true });
  assert.equal(hashed.status, 0, hashed.stderr);
  await fs.writeFile(path.join(directory, 'config.php'), `<?php return ['github_token'=>'TEST_ONLY_NO_NETWORK_TOKEN','users'=>['test'=>['password_hash'=>'${hashed.stdout}','name'=>'Test','enabled'=>true]]];`);
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(php, ['-S', `127.0.0.1:${port}`, 'tests/fixtures/php-admin-router.php'], {
    cwd: root, env: { ...process.env, JKS_PHP_TEST_DIR: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit').catch(() => {}); } await fs.rm(directory, { recursive: true, force: true }); });
  for (let i = 0; !output.includes('Development Server') && i < 100; i++) { if (child.exitCode !== null) throw new Error(output); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.match(output, /Development Server/);
  let cookie = '', csrf = '';
  async function request(action, body, extra = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const { res, text } = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: `/api/admin.php?action=${action}`, method: body === undefined ? 'GET' : 'POST',
        headers: { Host: 'jks.ooo', cookie, ...(body === undefined ? {} : { Origin: 'https://jks.ooo', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-CSRF-Token': csrf }), ...extra },
      }, incoming => {
        const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('error', reject);
        incoming.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) for (const item of Array.isArray(value) ? value : [value]) if (item != null) headers.append(name, item);
          resolve({ res: { status: incoming.statusCode, headers }, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.on('error', reject); req.end(payload);
    });
    for (const header of res.headers.getSetCookie()) cookie = header.split(';')[0];
    assert.ok(!text.includes('TEST_ONLY_NO_NETWORK_TOKEN'));
    assert.ok(!text.includes('password_hash'));
    const data = JSON.parse(text);
    if (data.csrf) csrf = data.csrf;
    return { res, data };
  }
  let reply = await request('session');
  assert.equal(reply.res.status, 200, JSON.stringify(reply.data)); assert.equal(reply.data.authenticated, false); assert.match(csrf, /^[a-f0-9]{64}$/);
  const header = reply.res.headers.get('set-cookie');
  assert.match(header, /HttpOnly/i); assert.match(header, /Secure/i); assert.match(header, /SameSite=Strict/i); assert.match(header, /path=\//i);
  const anonymousCookie = cookie, anonymousCsrf = csrf;
  reply = await request('login', { username: 'test', password }, { Origin: 'https://attacker.invalid' }); assert.equal(reply.res.status, 403);
  reply = await request('login', { username: 'test', password }, { 'X-CSRF-Token': 'bad' }); assert.equal(reply.res.status, 403);
  reply = await request('read&file=houses.json'); assert.equal(reply.res.status, 401);
  reply = await request('login', { username: 'test', password }); assert.equal(reply.res.status, 200); assert.equal(reply.data.authenticated, true);
  assert.notEqual(cookie, anonymousCookie); assert.notEqual(csrf, anonymousCsrf); assert.equal(reply.data.user.username, 'test');
  reply = await request('read&file=houses.json'); assert.equal(reply.res.status, 200); assert.deepEqual(reply.data.data, []);
  reply = await request('read&file=../.env'); assert.equal(reply.res.status, 422);
  reply = await request('password', { currentPassword: 'incorrect', newPassword }); assert.equal(reply.res.status, 403);
  const oldCookie = cookie;
  reply = await request('password', { currentPassword: password, newPassword }); assert.equal(reply.res.status, 200); assert.notEqual(cookie, oldCookie);
  reply = await request('logout', {}); assert.equal(reply.data.authenticated, false);
  reply = await request('login', { username: 'test', password }); assert.equal(reply.res.status, 401);
  reply = await request('login', { username: 'test', password: newPassword }); assert.equal(reply.res.status, 200);
  // A session idle beyond 30 minutes is rejected server-side, even with a valid cookie.
  const sessionFile = path.join(directory, 'sessions', 'sess_' + cookie.split('=')[1]);
  const session = await fs.readFile(sessionFile, 'utf8');
  await fs.writeFile(sessionFile, session.replace(/last_seen\|i:\d+;/, 'last_seen|i:' + (Math.floor(Date.now() / 1000) - 1801) + ';'));
  reply = await request('session'); assert.equal(reply.data.authenticated, false);
  reply = await request('login', { username: 'test', password: newPassword }); assert.equal(reply.res.status, 200);
  const currentConfig = await fs.readFile(path.join(directory, 'config.php'), 'utf8');
  await fs.writeFile(path.join(directory, 'config.php'), currentConfig.replace("'enabled' => true", "'enabled' => false"));
  reply = await request('session'); assert.equal(reply.data.authenticated, false);
  await fs.writeFile(path.join(directory, 'config.php'), currentConfig);
  reply = await request('login', { username: 'test', password: newPassword }); assert.equal(reply.res.status, 200);
  const freshSessionFile = path.join(directory, 'sessions', 'sess_' + cookie.split('=')[1]);
  const freshSession = await fs.readFile(freshSessionFile, 'utf8');
  await fs.writeFile(freshSessionFile, freshSession.replace(/created_at\|i:\d+;/, 'created_at|i:' + (Math.floor(Date.now() / 1000) - 28801) + ';'));
  reply = await request('session'); assert.equal(reply.data.authenticated, false);
  reply = await request('login', { username: 'test', password: newPassword }); assert.equal(reply.res.status, 200);
  reply = await request('logout', {}); assert.equal(reply.res.status, 200);
  for (let i = 0; i < 12; i++) { reply = await request('login', { username: 'unknown', password: 'incorrect' }); if (reply.res.status === 429) break; }
  assert.equal(reply.res.status, 429); assert.equal(reply.res.headers.get('retry-after'), '900');
  reply = await request('session&missing_config=1'); assert.equal(reply.res.status, 503); assert.equal(reply.data.error, 'not_configured');
});
