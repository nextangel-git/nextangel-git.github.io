// Офисный сервер ЖКС: webhook автопересборки + мини-админка на русском.
// Запуск: node scripts/rebuild-server.mjs   (рядом с CMS)
// Мини-админка: http://localhost:4777/admin  (пароль из .env ADMIN_PASSWORD)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.REBUILD_PORT || 4777;
const STRAPI = process.env.STRAPI_URL || 'http://localhost:1337';

// --- .env ---
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
// и из jks-cms/.env
const cmsEnv = path.resolve(ROOT, '../jks-cms/.env');
if (fs.existsSync(cmsEnv)) {
  for (const line of fs.readFileSync(cmsEnv, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const SECRET = process.env.REBUILD_SECRET || 'change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'jks-admin';
const WRITE_TOKEN = process.env.STRAPI_WRITE_TOKEN || '';
const SURGE_LOGIN = process.env.SURGE_LOGIN;
const SURGE_TOKEN = process.env.SURGE_TOKEN;
const SURGE_DOMAIN = process.env.SURGE_DOMAIN || 'jks-sosnovoborsk.surge.sh';

// --- пересборка ---
let queue = Promise.resolve();
let pending = false;

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, shell: true, env: { ...process.env, ...env } });
    p.stdout.on('data', (d) => process.stdout.write(d));
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function rebuild() {
  console.log(`[${new Date().toISOString()}] rebuild started`);
  await run('npm', ['run', 'build']);
  if (SURGE_LOGIN && SURGE_TOKEN) {
    await run('npx', ['--yes', 'surge', 'dist', SURGE_DOMAIN], { SURGE_LOGIN, SURGE_TOKEN });
    console.log('deployed to', SURGE_DOMAIN);
  } else {
    console.log('SURGE_* не заданы — только локальная сборка');
  }
  console.log('rebuild done');
}

function scheduleRebuild() {
  pending = true;
  queue = queue.then(async () => {
    if (!pending) return;
    pending = false;
    await new Promise((r) => setTimeout(r, 2000));
    await rebuild().catch((e) => console.error('rebuild failed:', e.message));
  });
}

// --- Strapi запись ---
async function strapiCreate(apiPath, data) {
  const res = await fetch(`${STRAPI}/api/${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WRITE_TOKEN}` },
    body: JSON.stringify({ data }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  return json;
}

// --- сессия мини-админки (HMAC-cookie) ---
function sign(v) { return crypto.createHmac('sha256', ADMIN_PASSWORD).update(v).digest('hex'); }
function isAuthed(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/jks_admin=([a-f0-9]{64})/);
  return m && m[1] === sign('ok');
}

// --- мини-админка HTML ---
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>УК «Жилкомсервис» — управление сайтом</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", system-ui, sans-serif; background: #f8fafc; color: #0f172a; }
  .top { background: #1f304f; color: #fff; padding: 14px 24px; display: flex; align-items: center; gap: 12px; }
  .top img { height: 30px; background: #fff; border-radius: 6px; padding: 2px 6px; }
  .wrap { max-width: 720px; margin: 28px auto; padding: 0 16px; }
  h1 { font-size: 1.3rem; margin-bottom: 4px; }
  .sub { color: #64748b; font-size: .9rem; margin-bottom: 22px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 22px; margin-bottom: 18px; }
  .card h2 { font-size: 1.05rem; margin-bottom: 14px; color: #3856a3; }
  label { display: block; font-size: .85rem; font-weight: 600; margin: 10px 0 4px; color: #334155; }
  input, select, textarea { width: 100%; font: inherit; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 8px; }
  textarea { resize: vertical; }
  button, .btn { background: #3856a3; color: #fff; border: none; border-radius: 8px; padding: 11px 22px; font: inherit; font-weight: 600; cursor: pointer; margin-top: 14px; }
  button:hover { background: #2c468a; }
  .msg { margin-top: 12px; padding: 10px 14px; border-radius: 8px; font-size: .9rem; display: none; }
  .ok { display: block; background: #f0fdf4; border: 1px solid #86efac; color: #166534; }
  .err { display: block; background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  #recent { font-size: .85rem; color: #64748b; }
  #recent li { margin: 4px 0; }
  .login { max-width: 380px; margin: 80px auto; }
</style>
</head>
<body>
<div class="top"><img src="/logo.svg" alt="ЖКС" onerror="this.style.display='none'"><strong>Управление сайтом</strong></div>
<div class="wrap" id="app">…</div>
<script>
const app = document.getElementById('app');
let LAST = '';

function show(el, msg, ok) { el.textContent = msg; el.className = 'msg ' + (ok ? 'ok' : 'err'); }

async function post(path, data, msgEl) {
  const res = await fetch(path, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Ошибка ' + res.status);
  return json;
}

function formNews() {
  return \`<div class="card"><h2>📰 Добавить новость</h2>
    <label>Заголовок *</label><input id="n-title">
    <label>Текст (короткий анонс)</label><textarea id="n-desc" rows="3"></textarea>
    <label>Ссылка (если есть)</label><input id="n-url" placeholder="https://…">
    <button onclick="sendNews()">Опубликовать новость</button>
    <div class="msg" id="n-msg"></div></div>\`;
}
function formShutdown() {
  return \`<div class="card"><h2>⚠️ Сообщить об отключении</h2>
    <label>Что отключается *</label><input id="s-what" placeholder="Горячая вода">
    <label>Где (адреса) *</label><input id="s-place" placeholder="ул. Юности, 1–19">
    <div class="row"><div><label>С *</label><input id="s-from" placeholder="03.11.2026 09:00"></div>
    <div><label>По *</label><input id="s-to" placeholder="03.11.2026 18:00"></div></div>
    <label>Причина</label><input id="s-reason" placeholder="Плановые работы">
    <button onclick="sendShutdown()">Опубликовать отключение</button>
    <div class="msg" id="s-msg"></div></div>\`;
}
function formDoc() {
  return \`<div class="card"><h2>📄 Добавить документ</h2>
    <label>Название *</label><input id="d-name">
    <label>Категория *</label><select id="d-cat">
      <option>Отчёты по договору управления</option><option>Протоколы собраний</option>
      <option>Бухгалтерская отчётность</option><option>Тарифы на коммунальные ресурсы</option>
      <option>Сведения о выполняемых работах</option><option>Нормативно-правовые акты</option></select>
    <label>Год</label><input id="d-year" type="number" placeholder="2026">
    <label>Ссылка на файл *</label><input id="d-url" placeholder="https://…/document.pdf">
    <button onclick="sendDoc()">Добавить документ</button>
    <div class="msg" id="d-msg"></div></div>\`;
}

async function sendNews() {
  const msg = document.getElementById('n-msg');
  try {
    const title = document.getElementById('n-title').value.trim();
    if (!title) throw new Error('Введите заголовок');
    await post('/admin/api/news', { title, desc: document.getElementById('n-desc').value.trim(), url: document.getElementById('n-url').value.trim() }, msg);
    show(msg, 'Новость опубликована. Сайт обновится через ~1 минуту.', true);
    document.getElementById('n-title').value = ''; document.getElementById('n-desc').value = ''; document.getElementById('n-url').value = '';
  } catch (e) { show(msg, e.message, false); }
}
async function sendShutdown() {
  const msg = document.getElementById('s-msg');
  try {
    const what = document.getElementById('s-what').value.trim();
    const place = document.getElementById('s-place').value.trim();
    if (!what || !place) throw new Error('Заполните «что» и «где»');
    await post('/admin/api/shutdown', { what, place, date_from: document.getElementById('s-from').value.trim(), date_to: document.getElementById('s-to').value.trim(), reason: document.getElementById('s-reason').value.trim() }, msg);
    show(msg, 'Отключение опубликовано на главной. Снимите его, когда закончится.', true);
  } catch (e) { show(msg, e.message, false); }
}
async function sendDoc() {
  const msg = document.getElementById('d-msg');
  try {
    const name = document.getElementById('d-name').value.trim();
    const url = document.getElementById('d-url').value.trim();
    if (!name || !url) throw new Error('Нужны название и ссылка на файл');
    await post('/admin/api/document', { name, cat: document.getElementById('d-cat').value, year: document.getElementById('d-year').value, url }, msg);
    show(msg, 'Документ добавлен в «Раскрытие информации».', true);
    document.getElementById('d-name').value = ''; document.getElementById('d-url').value = '';
  } catch (e) { show(msg, e.message, false); }
}

async function boot() {
  const res = await fetch('/admin/api/check');
  if (res.status === 401) {
    app.innerHTML = \`<div class="card login"><h2>Вход для сотрудников</h2>
      <label>Пароль</label><input id="pw" type="password" autofocus onkeydown="if(event.key==='Enter')login()">
      <button onclick="login()" style="width:100%">Войти</button>
      <div class="msg" id="l-msg"></div></div>\`;
    return;
  }
  app.innerHTML = '<h1>Что публикуем?</h1><p class="sub">Изменения появляются на сайте автоматически через ~1 минуту после публикации.</p>' + formNews() + formShutdown() + formDoc();
}
async function login() {
  const msg = document.getElementById('l-msg');
  try {
    await post('/admin/api/login', { password: document.getElementById('pw').value }, msg);
    boot();
  } catch (e) { show(msg, 'Неверный пароль', false); }
}
boot();
</script>
</body>
</html>`;

// --- сервер ---
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // webhook от Strapi
  if (req.method === 'POST' && url.pathname === '/rebuild') {
    if (req.headers['x-rebuild-secret'] !== SECRET) { res.writeHead(403).end('forbidden'); return; }
    scheduleRebuild();
    res.writeHead(202).end('queued');
    return;
  }

  // логотип для админки
  if (req.method === 'GET' && url.pathname === '/logo.svg') {
    const logo = path.join(ROOT, 'public', 'logo.svg');
    if (fs.existsSync(logo)) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); fs.createReadStream(logo).pipe(res); return; }
  }

  // мини-админка
  if (url.pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ADMIN_HTML);
    return;
  }
  if (url.pathname === '/admin/api/check') {
    res.writeHead(isAuthed(req) ? 200 : 401).end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/login') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let ok = false;
      try { ok = JSON.parse(body).password === ADMIN_PASSWORD; } catch {}
      if (ok) {
        res.writeHead(200, { 'Set-Cookie': `jks_admin=${sign('ok')}; Path=/; HttpOnly; SameSite=Strict`, 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } else {
        res.writeHead(401).end('{"error":"Неверный пароль"}');
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/admin/api/')) {
    if (!isAuthed(req)) { res.writeHead(401).end('{"error":"Не авторизован"}'); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const d = JSON.parse(body);
        const kind = url.pathname.split('/').pop();
        if (kind === 'news') {
          const today = new Date().toLocaleDateString('ru-RU');
          await strapiCreate('news-items', { title: d.title, desc: d.desc || '', url: d.url || '', date: today });
        } else if (kind === 'shutdown') {
          await strapiCreate('shutdowns', { what: d.what, place: d.place, date_from: d.date_from || '', date_to: d.date_to || '', reason: d.reason || '', active: true });
        } else if (kind === 'document') {
          await strapiCreate('documents', { name: d.name, cat: d.cat, year: d.year ? parseInt(d.year) : null, url: d.url, ext: 'PDF' });
        } else {
          res.writeHead(404).end('{"error":"?"}'); return;
        }
        scheduleRebuild();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404).end('not found');
}).listen(PORT, () => console.log(`офисный сервер на :${PORT} — мини-админка: http://localhost:${PORT}/admin`));
