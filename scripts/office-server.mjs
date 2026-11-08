// Офисный сервер ЖКС: своя админка (полный CRUD по данным сайта) + автопересборка.
// Запуск: node scripts/office-server.mjs   →  http://localhost:4777/admin
// Данные — JSON-файлы в src/data/. После каждого сохранения сайт пересобирается
// (и деплоится, если заданы SURGE_* в .env).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { COLLECTIONS } from './collections.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'src', 'data');
const PORT = process.env.ADMIN_PORT || 4777;

// --- .env (jks-site/.env) ---
for (const f of [path.join(ROOT, '.env')]) {
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'jks-admin';
const SURGE_LOGIN = process.env.SURGE_LOGIN;
const SURGE_TOKEN = process.env.SURGE_TOKEN;
const SURGE_DOMAIN = process.env.SURGE_DOMAIN || 'jks-sosnovoborsk.surge.sh';

// --- пересборка (дебаунс) ---
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
  }
  console.log('rebuild done');
}

export function scheduleRebuild() {
  pending = true;
  queue = queue.then(async () => {
    if (!pending) return;
    pending = false;
    await new Promise((r) => setTimeout(r, 2000));
    await rebuild().catch((e) => console.error('rebuild failed:', e.message));
  });
}

// --- данные ---
function readCol(name) {
  const cfg = COLLECTIONS[name];
  if (!cfg) return null;
  const f = path.join(DATA, cfg.file);
  if (!fs.existsSync(f)) return cfg.dict ? {} : [];
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}
function writeCol(name, data) {
  const cfg = COLLECTIONS[name];
  fs.writeFileSync(path.join(DATA, cfg.file), JSON.stringify(data, null, 1) + '\n', 'utf-8');
}

// --- сессия ---
function sign(v) { return crypto.createHmac('sha256', ADMIN_PASSWORD).update(v).digest('hex'); }
function isAuthed(req) {
  const m = (req.headers.cookie || '').match(/jks_admin=([a-f0-9]{64})/);
  return m && m[1] === sign('ok');
}

function readBody(req) {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { res(JSON.parse(b)); } catch { res({}); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// --- сервер ---
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/logo.svg') {
    const logo = path.join(ROOT, 'public', 'logo.svg');
    if (fs.existsSync(logo)) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); fs.createReadStream(logo).pipe(res); return; }
  }
  if (req.method === 'GET' && url.pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(ROOT, 'scripts', 'admin.html')).pipe(res);
    return;
  }

  // логин
  if (req.method === 'POST' && url.pathname === '/admin/api/login') {
    const d = await readBody(req);
    if (d.password === ADMIN_PASSWORD) {
      res.writeHead(200, { 'Set-Cookie': `jks_admin=${sign('ok')}; Path=/; HttpOnly; SameSite=Strict`, 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } else { json(res, 401, { error: 'Неверный пароль' }); }
    return;
  }
  if (url.pathname === '/admin/api/check') {
    res.writeHead(isAuthed(req) ? 200 : 401).end(); return;
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/config') {
    if (!isAuthed(req)) { json(res, 401, {}); return; }
    json(res, 200, Object.fromEntries(Object.entries(COLLECTIONS).map(([k, v]) => [k, { label: v.label, singular: v.singular, fields: v.fields, itemFields: v.itemFields, nested: !!v.nested, dict: !!v.dict, readonly: !!v.readonly }])));
    return;
  }

  // CRUD
  const m = url.pathname.match(/^\/admin\/api\/col\/([a-z_]+)(?:\/(\d+|[\w-]+))?$/);
  if (m && url.pathname.startsWith('/admin/api/col/')) {
    if (!isAuthed(req)) { json(res, 401, { error: 'Не авторизован' }); return; }
    const [, colName, idxRaw] = m;
    const cfg = COLLECTIONS[colName];
    if (!cfg) { json(res, 404, { error: 'нет коллекции' }); return; }

    if (req.method === 'GET') { json(res, 200, readCol(colName)); return; }
    if (cfg.readonly) { json(res, 403, { error: 'Только чтение' }); return; }

    const data = readCol(colName);
    const idx = idxRaw !== undefined ? (cfg.dict ? idxRaw : parseInt(idxRaw)) : undefined;

    if (req.method === 'POST') {
      const d = await readBody(req);
      const entry = { ...(cfg.defaults ? cfg.defaults() : {}), ...d };
      if (cfg.dict) {
        const slug = d.slug || String(Date.now());
        data[slug] = entry;
      } else {
        data.unshift(entry);
      }
      writeCol(colName, data); scheduleRebuild();
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'PUT' && idx !== undefined) {
      const d = await readBody(req);
      if (d.__replaceAll) {
        // вложенные коллекции (услуги): замена целиком
        writeCol(colName, d.data);
        scheduleRebuild();
        json(res, 200, { ok: true }); return;
      }
      if (cfg.dict) {
        if (!(idx in data)) { json(res, 404, { error: 'нет записи' }); return; }
        data[idx] = { ...data[idx], ...d };
      } else {
        if (isNaN(idx) || !data[idx]) { json(res, 404, { error: 'нет записи' }); return; }
        data[idx] = { ...data[idx], ...d };
      }
      writeCol(colName, data); scheduleRebuild();
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'DELETE' && idx !== undefined) {
      if (cfg.dict) { delete data[idx]; } else { data.splice(idx, 1); }
      writeCol(colName, data); scheduleRebuild();
      json(res, 200, { ok: true }); return;
    }
    json(res, 405, { error: 'метод?' }); return;
  }

  json(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`админка ЖКС: http://localhost:${PORT}/admin`));
