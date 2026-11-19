// Классическая админка сайта УК «Жилкомсервис».
// Логин/пароль (bcrypt) + SVG-капча; 2FA отключена владельцем.
// Запись: src/data/*.json → git commit + push → GitHub Actions пересобирают сайт.
// GitHub PAT живёт только здесь, на сервере (в credential manager git) — в браузер не отдаётся.
//
// Запуск:   npm install && npm start          (порт 4777, http://127.0.0.1:4777)
// Добавить пользователя:  node server.mjs --add-user <login> "<Имя>" <пароль>
// Сменить пароль:         node server.mjs --passwd <login> <новый пароль>

import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import svgCaptcha from 'svg-captcha';
import fs from 'node:fs';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { npmCommand, runLogged } from './process.mjs';
import { localSyncBlockReason } from './sync-owner.mjs';
import { fileURLToPath } from 'node:url';
import { COLLECTIONS } from '../src/lib/collections.mjs';
import { mergeRecord, validateKey, validateUpload, recordAt, updateHouseGeo } from '../src/lib/admin-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const TEST_DIR = process.env.NODE_ENV === 'test' ? process.env.JKS_ADMIN_TEST_DIR : null;
const STATE = TEST_DIR ? path.resolve(TEST_DIR) : __dirname;
const DATA = TEST_DIR ? path.join(STATE, 'data') : path.join(REPO, 'src', 'data');
const DOCUMENTS = TEST_DIR ? path.join(STATE, 'documents') : path.join(REPO, 'public', 'documents');
const USERS_FILE = path.join(STATE, 'users.json');
const PORT = process.env.PORT || 4777;
const HOST = process.env.HOST || '127.0.0.1';
const DEV = process.env.NODE_ENV !== 'production';
// 2FA отключена владельцем; вход по паролю и капче.
// Режим хостинга: REBUILD=1 → после каждого сохранения пересобираем сайт локально (astro build),
// GIT_PUSH=0 → не пушить в GitHub (репо тогда просто бэкап). На GitHub Pages: REBUILD=0, GIT_PUSH=1.
const REBUILD = process.env.REBUILD === '1';
const GIT_PUSH = process.env.GIT_PUSH !== '0';

/* ---------------- пользователи ---------------- */
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 1) + '\n'); }

/* ---------------- CLI ---------------- */
const cli = process.argv.slice(2);
if (cli[0] === '--add-user') {
  const [, login, name, password] = cli;
  if (!login || !name || !password) { console.error('Использование: node server.mjs --add-user <login> "<Имя>" <пароль>'); process.exit(1); }
  const users = loadUsers();
  if (users.find(u => u.login === login)) { console.error('Такой логин уже есть'); process.exit(1); }
  users.push({ login, name, passHash: bcrypt.hashSync(password, 10), totpSecret: null, role: users.length ? 'editor' : 'admin' });
  saveUsers(users);
  console.log(`Пользователь «${login}» (${name}) создан, роль: ${users[users.length - 1].role}. Вход по паролю и капче.`);
  process.exit(0);
}
if (cli[0] === '--passwd') {
  const users = loadUsers();
  const u = users.find(x => x.login === cli[1]);
  if (!u || !cli[2]) { console.error('Использование: node server.mjs --passwd <login> <новый пароль>'); process.exit(1); }
  u.passHash = bcrypt.hashSync(cli[2], 10); saveUsers(users);
  console.log(`Пароль «${cli[1]}» изменён.`);
  process.exit(0);
}

/* ---------------- приложение ---------------- */
// секрет сессий: из env, иначе — постоянный из файла admin/.secret (не в git), сессии в памяти, перезапуск требует нового входа
const SECRET_FILE = path.join(STATE, '.secret');
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch { }
  const s = randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s);
  return s;
}

const app = express();
app.disable('x-powered-by');
if (process.env.HTTPS === '1') app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: sessionSecret(),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: !DEV && process.env.HTTPS === '1', maxAge: 8 * 3600 * 1000 },
}));

// Every form gets a CSRF token; reject cross-origin writes before reading uploads.
app.use((req, res, next) => {
  req.session.csrf ||= randomBytes(32).toString('hex');
  const send = res.send.bind(res);
  res.send = (body) => send(typeof body === 'string' ? body.replace(/(<form\b[^>]*>)/gi, `$1<input type="hidden" name="__csrf" value="${req.session.csrf}">`) : body);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const expectedOrigin = `${req.protocol}://${req.get('host')}`;
    if (req.get('sec-fetch-site') === 'cross-site' || (req.get('origin') && req.get('origin') !== expectedOrigin))
      return res.status(403).send('Запрос с другого сайта отклонён');
    if (!req.is('multipart/form-data')) return csrf(req, res, next);
  }
  next();
});
function csrf(req, res, next) {
  const sent = String(req.body?.__csrf || '');
  const expected = String(req.session.csrf || '');
  if (Buffer.byteLength(sent) !== Buffer.byteLength(expected) || !sent || !timingSafeEqual(Buffer.from(sent), Buffer.from(expected)))
    return res.status(403).send('Форма устарела. Обновите страницу.');
  next();
}

// простая защита от перебора: 5 неудач → пауза 10 минут на IP
const fails = new Map();
const throttled = (ip) => { const f = fails.get(ip); return f && f.count >= 5 && Date.now() - f.at < 10 * 60 * 1000; };
const fail = (ip) => { const f = fails.get(ip) || { count: 0, at: 0 }; f.count++; f.at = Date.now(); fails.set(ip, f); };
const okFail = (ip) => fails.delete(ip);

/* ---------------- иконки (inline SVG, 18px) ---------------- */
const I = {
  news: '<path d="M4 5h13v12a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2V5z"/><path d="M17 8h2a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2"/><path d="M7 9h7M7 13h7"/>',
  documents: '<path d="M6 3h8l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><path d="M8 12h8M8 16h8"/>',
  houses: '<path d="M3 21V10l9-7 9 7v11"/><path d="M9 21v-6h6v6"/><path d="M3 21h18"/>',
  shutdowns: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
  faq: '<path d="M8 10h.01M12 10h.01M16 10h.01"/><path d="M21 12a9 9 0 1 1-4-7.5L21 3l-1 4.5A8.9 8.9 0 0 1 21 12z"/>',
  useful: '<path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 0 2 2h13"/>',
  services: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4L14 13l-3-3 3.7-3.7z"/>',
  vk_posts: '<path d="M21 4 3 11l6 2 2 6 10-15z"/><path d="M9 13l5-5"/>',
  requests: '<path d="M3 8l9 6 9-6"/><rect x="3" y="5" width="18" height="14" rx="2"/>',
  dashboard: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M17.5 13.5A6.5 6.5 0 0 1 21.5 20"/>',
  key: '<circle cx="8" cy="14" r="5"/><path d="M11.5 10.5 20 2"/><path d="M15 7l3 3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  sync: '<path d="M21 12a9 9 0 1 1-2.9-6.6"/><path d="M21 3v6h-6"/>',
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>',
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none">${I[name] || I.dashboard}</svg>`;

/* ---------------- шаблоны ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
:root{--blue:#1d4ed8;--blue2:#3b82f6;--ink:#0f172a;--mut:#64748b;--bg:#eef2f7;--card:#fff;--line:#e5eaf2;--red:#dc2626;--green:#16a34a;--amber:#d97706;--r:14px;--shadow:0 1px 2px rgba(15,23,42,.05),0 4px 16px rgba(15,23,42,.06)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:1.4rem;margin:0;letter-spacing:-.01em}h2{font-size:1.05rem;margin:0 0 10px}
input,textarea,select{width:100%;padding:11px 14px;border:1.5px solid var(--line);border-radius:10px;font:inherit;background:#fff;transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus,select:focus{outline:0;border-color:var(--blue2);box-shadow:0 0 0 3px rgba(59,130,246,.18)}
textarea{min-height:130px;resize:vertical}
label{display:block;font-weight:600;font-size:.9rem;margin:16px 0 6px}
.hint{font-weight:400;color:var(--mut);font-size:.8rem;margin-left:6px}
.btn{display:inline-flex;align-items:center;gap:8px;border:0;border-radius:10px;padding:11px 20px;font:inherit;font-weight:600;cursor:pointer;background:var(--blue);color:#fff;transition:filter .15s,transform .05s}
.btn:hover{filter:brightness(1.08);text-decoration:none}.btn:active{transform:scale(.98)}
.btn.ghost{background:#e6ebf3;color:var(--ink)}.btn.red{background:var(--red)}
.btn.sm{padding:6px 13px;font-size:.83rem;border-radius:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:22px;box-shadow:var(--shadow)}
/* каркас */
.layout{display:flex;min-height:100vh}
.side{width:250px;flex:none;background:linear-gradient(180deg,#0b1220 0%,#14213d 100%);color:#cbd5e1;display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.brand{display:flex;gap:12px;align-items:center;padding:20px 18px 16px;border-bottom:1px solid rgba(255,255,255,.08)}
.brand img{width:38px;height:38px;border-radius:9px;background:#fff;padding:3px}
.brand b{color:#fff;font-size:.95rem;line-height:1.2;display:block}.brand span{font-size:.72rem;color:#7c8db0}
.snav{padding:12px 10px;overflow:auto;flex:1}
.snav a{display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:9px;color:#cbd5e1;font-weight:500;font-size:.92rem;margin-bottom:2px}
.snav a:hover{background:rgba(255,255,255,.07);text-decoration:none;color:#fff}
.snav a.on{background:var(--blue);color:#fff}
.snav a .n{margin-left:auto;font-size:.72rem;background:rgba(255,255,255,.13);border-radius:20px;padding:1px 8px;color:#e2e8f0}
.snav a.on .n{background:rgba(255,255,255,.22)}
.snav .cap{font-size:.68rem;text-transform:uppercase;letter-spacing:.09em;color:#61708f;padding:14px 12px 6px}
.sfoot{padding:14px;border-top:1px solid rgba(255,255,255,.08);font-size:.8rem}
.sfoot a{color:#94a3b8}
.main{flex:1;min-width:0;padding:26px 30px 40px}
.crumbs{font-size:.83rem;color:var(--mut);margin-bottom:8px}.crumbs a{color:var(--mut)}
.pagehead{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.userchip{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--line);border-radius:30px;padding:6px 14px 6px 6px;font-size:.88rem;font-weight:600;box-shadow:var(--shadow)}
.userchip .av{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,var(--blue),#7c3aed);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700}
.userchip a{color:var(--mut);font-weight:400}
/* дашборд */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:14px}
.ccard{display:flex;gap:14px;align-items:center;background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:16px;color:var(--ink);box-shadow:var(--shadow);transition:transform .12s,box-shadow .12s}
.ccard:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(15,23,42,.12);text-decoration:none}
.ccard .ic{width:44px;height:44px;flex:none;border-radius:11px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#dbeafe,#eff6ff);color:var(--blue)}
.ccard b{font-size:1.45rem;line-height:1;display:block}
.ccard small{color:var(--mut);font-size:.8rem;display:block;margin-top:3px}
.ccard .ro{font-size:.68rem;color:var(--amber);font-weight:600}
/* таблицы */
.tblwrap{background:#fff;border:1px solid var(--line);border-radius:var(--r);overflow:auto;box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse;min-width:420px}
td,th{padding:11px 16px;text-align:left;vertical-align:middle;border-bottom:1px solid var(--line);font-size:.92rem}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:#f6f9ff}
tr.cat td{background:#f1f5ff;font-weight:700;color:#1e3a8a;font-size:.82rem;text-transform:uppercase;letter-spacing:.04em}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.toolbar .search{flex:1;min-width:200px;position:relative}
.toolbar .search input{padding-left:38px}
.toolbar .search svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--mut)}
/* тосты */
.toast{position:fixed;right:22px;bottom:22px;z-index:50;display:flex;align-items:center;gap:10px;padding:14px 18px;border-radius:12px;color:#fff;font-weight:600;box-shadow:0 10px 30px rgba(15,23,42,.25);animation:tin .3s ease;max-width:min(420px,90vw)}
.toast.ok{background:var(--green)}.toast.err{background:var(--red)}
@keyframes tin{from{transform:translateY(14px);opacity:0}}
/* вход */
.authpage{min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(1000px 500px at 20% 0%,#1e3a8a 0%,#0b1220 55%),#0b1220;padding:20px}
.authcard{width:100%;max-width:400px;background:#fff;border-radius:18px;padding:32px;box-shadow:0 25px 60px rgba(0,0,0,.45)}
.authcard .alogo{display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:6px;text-align:center}
.authcard .alogo img{width:64px;height:64px;border-radius:14px}
.authcard h1{font-size:1.25rem}
.cap{display:flex;gap:10px;align-items:center}
.cap .capimg{border:1.5px solid var(--line);border-radius:10px;background:#f8fafc;height:48px;display:flex;align-items:center;padding:0 6px}
.cap .capimg svg{height:38px}
.muted{color:var(--mut);font-size:.85rem}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.badge{display:inline-block;font-size:.72rem;font-weight:700;padding:2px 9px;border-radius:20px;background:#dcfce7;color:#166534}
.badge.off{background:#fee2e2;color:#b91c1c}
.mono{font-family:ui-monospace,Consolas,monospace;background:#f1f5f9;border:1px solid var(--line);border-radius:8px;padding:12px 14px;font-size:.83rem;overflow:auto}
.drop{border:2px dashed var(--line);border-radius:12px;padding:18px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s;background:#fafbfe}
@media(max-width:900px){.side{width:66px}.brand b,.brand span,.snav .cap,.snav a .n,.snav a span.t{display:none}.snav a{justify-content:center;padding:11px}.main{padding:18px}}
`;

function toastHtml(req) {
  const mk = (cls, text) => `<div class="toast ${cls}" id="toast">${esc(text)}</div><script>setTimeout(()=>{const t=document.getElementById('toast');if(t){t.style.transition='opacity .4s';t.style.opacity=0;setTimeout(()=>t.remove(),400)}},4500)</script>`;
  if (req.query.ok) return mk('ok', req.query.ok);
  if (req.query.err) return mk('err', req.query.err);
  return '';
}

function counts() {
  const out = {};
  for (const [name, cfg] of Object.entries(COLLECTIONS)) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA, cfg.file), 'utf8'));
      out[name] = cfg.nested ? d.reduce((s, c) => s + (c.items || []).length, 0) : Array.isArray(d) ? d.length : Object.keys(d).length;
    } catch { out[name] = null; }
  }
  return out;
}

function page(title, body, user = null, active = '', req = null) {
  const n = user ? counts() : {};
  const navItem = (name, cfg) => `<a href="/c/${name}" class="${active === name ? 'on' : ''}">${icon(name)}<span class="t">${esc(cfg.label)}</span>${n[name] != null ? `<span class="n">${n[name]}</span>` : ''}</a>`;
  const crumbs = active === '' ? 'Разделы' : `<a href="/">Разделы</a> → ${esc(COLLECTIONS[active]?.label || title)}`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Админка ЖКС</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>${CSS}</style></head><body>
${user ? `<div class="layout">
<aside class="side">
  <div class="brand"><img src="/logo.svg" alt="ЖКС"><div><b>Жилкомсервис</b><span>админ-панель</span></div></div>
  <nav class="snav">
    <a href="/" class="${active === 'dash' ? 'on' : ''}">${icon('dashboard')}<span class="t">Дашборд</span></a>
    <div class="cap">Контент</div>
    ${Object.entries(COLLECTIONS).map(([name, cfg]) => navItem(name, cfg)).join('')}
    <div class="cap">Система</div>
    <a href="/password" class="${active === 'password' ? 'on' : ''}">${icon('key')}<span class="t">Сменить пароль</span></a>
    <a href="/sync" class="${active === 'sync' ? 'on' : ''}">${icon('sync')}<span class="t">Синхронизация</span></a>
    ${user.role === 'admin' ? `<a href="/users" class="${active === 'users' ? 'on' : ''}">${icon('users')}<span class="t">Пользователи</span></a>` : ''}
    <a href="https://nextangel-git.github.io" target="_blank" rel="noopener">${icon('eye')}<span class="t">Открыть сайт ↗</span></a>
  </nav>
  <div class="sfoot"><a href="/logout">${icon('logout', 14)} Выйти</a></div>
</aside>
<main class="main">
  <div class="pagehead">
    <div><div class="crumbs">${crumbs}</div><h1>${esc(title)}</h1></div>
    <div class="userchip"><span class="av">${esc((user.name || '?')[0].toUpperCase())}</span>${esc(user.name)} · <a href="/logout">выйти</a></div>
  </div>
  ${body}
</main></div>` : body}
${req ? toastHtml(req) : ''}
</body></html>`;
}

/* ---------------- вход: пароль + капча, затем 2FA ---------------- */
function authPage(title, inner) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Админка ЖКС</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>${CSS}</style></head><body>
<div class="authpage"><div class="authcard">
  <div class="alogo"><img src="/logo.svg" alt="ЖКС"><h1>${esc(title)}</h1><p class="muted" style="margin:0">УК «Жилкомсервис» · Сосновоборск</p></div>
  ${inner}
</div></div>${'' /* toast через redirect?ok/err не используется на auth-страницах, сообщения инлайн */}</body></html>`;
}
const errInline = (req) => req.query.err ? `<p class="muted" style="color:var(--red);font-weight:600">${esc(req.query.err)}</p>` : '';
const okInline = (req) => req.query.ok ? `<p class="muted" style="color:var(--green);font-weight:600">${esc(req.query.ok)}</p>` : '';

app.get('/login', (req, res) => {
  const cap = svgCaptcha.create({ size: 5, noise: 3, color: true, ignoreChars: '0oO1ilI' });
  req.session.captcha = cap.text.toLowerCase();
  if (TEST_DIR) console.log(`[test] captcha: ${cap.text}`);
  res.send(authPage('Вход в админку', `
    ${errInline(req)}
    <form method="post" action="/login">
      <label>Логин</label><input name="login" required autocomplete="username" autofocus>
      <label>Пароль</label><input name="password" type="password" required autocomplete="current-password">
      <label>Я не робот <span class="hint">введите символы с картинки</span></label>      <div class="cap"><span class="capimg">${cap.data}</span><input name="captcha" required autocomplete="off" placeholder="Символы" style="flex:1"></div>
      <p style="margin:22px 0 0"><button class="btn" type="submit" style="width:100%;justify-content:center">Войти</button></p>
    </form>`));
});

app.post('/login', (req, res) => {
  const ip = req.ip;
  if (throttled(ip)) return res.redirect('/login?err=' + encodeURIComponent('Слишком много попыток. Подождите 10 минут.'));
  const { login, password, captcha } = req.body;
  const capOk = typeof captcha === 'string' && req.session.captcha && captcha.toLowerCase() === req.session.captcha;
  req.session.captcha = null;
  const u = loadUsers().find(x => x.login === String(login || '').trim());
  if (!capOk || !u || !bcrypt.compareSync(String(password || ''), u.passHash)) {
    fail(ip);
    return res.redirect('/login?err=' + encodeURIComponent(!capOk ? 'Неверные символы с картинки' : 'Неверный логин или пароль'));
  }
  okFail(ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Не удалось создать сессию');
    req.session.user = u.login;
    req.session.authVersion = u.passHash;
    res.redirect('/');
  });
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

/* ---------------- auth middleware ---------------- */
function auth(req, res, next) {
  const u = loadUsers().find(x => x.login === req.session.user);
  if (!u || req.session.authVersion !== u.passHash) return res.redirect('/login');
  req.user = u; next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.redirect('/?err=' + encodeURIComponent('Только для администратора'));
  next();
}

/* ---------------- статика: логотип из public сайта ---------------- */
app.get('/logo.svg', (req, res) => res.sendFile(path.join(REPO, 'public', 'logo.svg')));
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(REPO, 'public', 'favicon.svg'), (e) => { if (e) res.redirect('/logo.svg'); }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 40 },
  fileFilter: (req, file, done) => {
    try { validateUpload({ name: file.originalname, size: 1 }); done(null, true); }
    catch (error) { error.status = 400; done(error); }
  }, // 25 МБ на документ
  defParamCharset: 'utf8', // иначе busboy ломает кириллицу в полях формы (latin1 по умолчанию)
});

// транслитерация имени файла: кириллица → латиница, безопасное имя для URL
const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function safeName(name) {
  const base = name.toLowerCase().split('').map(c => TR[c] ?? c).join('')
    .replace(/[^a-z0-9.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return base || 'file';
}

/* ---------------- данные + git + пересборка ---------------- */
const readData = (file) => JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
const writeData = (file, data) => {
  const target = path.join(DATA, file);
  const temporary = target + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 1) + '\n');
  fs.renameSync(temporary, target);
};
const revision = (data) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
function assertRevision(req, res, data) {
  if (req.body.__revision === revision(data)) return true;
  res.status(409).send('Данные изменились. Обновите список и повторите правку; чужие изменения не перезаписаны.');
  return false;
}

let buildState = { running: false, last: null, ok: null };
let buildTimer = null;
function scheduleRebuild() {
  if (!REBUILD) return;
  clearTimeout(buildTimer);
  buildTimer = setTimeout(() => {
    if (buildState.running) { scheduleRebuild(); return; } // подождём окончания текущей сборки
    buildState = { running: true, last: new Date(), ok: null };
    const logFile = path.join(STATE, 'build.log');
    try {
      const [command, ...args] = npmCommand();
      runLogged(command, args, { cwd: REPO, logFile,
        onFinish: ({ code, error }) => { buildState = { running: false, last: new Date(), ok: code === 0, error }; },
      });
    } catch (error) {
      buildState = { running: false, last: new Date(), ok: false, error: error.message };
      try { fs.writeFileSync(logFile, error.message + '\n'); } catch { /* state still reports failure */ }
    }
  }, 5000); // дебаунс 5 сек — серия правок = одна сборка
}

function gitSync(message, changedPaths) {
  if (TEST_DIR) return null;
  try {
    const paths = [...new Set(changedPaths)];
    if (!paths.length || paths.some(file => !/^(src\/data\/[a-z_]+\.json|public\/documents\/[a-z0-9][a-z0-9.-]*)$/.test(file)))
      throw new Error('Неверный список файлов для коммита');
    execFileSync('git', ['add', '--', ...paths], { cwd: REPO, stdio: 'pipe' });
    // Do not accidentally commit unrelated changes staged by the developer.
    execFileSync('git', ['commit', '--only', '-m', message, '--', ...paths], { cwd: REPO, stdio: 'pipe' });
    if (GIT_PUSH) execFileSync('git', ['push', 'origin', 'main'], { cwd: REPO, stdio: 'pipe', timeout: 60000 });
    scheduleRebuild();
    return null;
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || e.message || '');
    if (out.includes('nothing to commit') || out.includes('no changes added')) { scheduleRebuild(); return null; }
    return 'Сохранено локально, но git не удался: ' + out.slice(0, 300);
  }
}

// текст-подсказка после сохранения зависит от режима
const savedText = () => REBUILD
  ? 'Сохранено. Сайт пересобирается прямо на сервере (~1–2 минуты).'
  : 'Сохранено. Сайт обновится через ~2–3 минуты (GitHub Actions).';

/* ---------------- дашборд ---------------- */
app.get('/', auth, (req, res) => {
  const n = counts();
  const cards = Object.entries(COLLECTIONS).map(([name, cfg]) => `
    <a class="ccard" href="/c/${name}">
      <span class="ic">${icon(name, 22)}</span>
      <span><b>${n[name] ?? '—'}</b><small>${esc(cfg.label)}</small>${cfg.readonly ? '<span class="ro">ТОЛЬКО ЧТЕНИЕ</span>' : ''}</span>
    </a>`).join('');
  res.send(page('Дашборд', `
    <p class="muted" style="margin-top:0">${REBUILD ? 'Изменения сохраняются и сайт пересобирается прямо на этом сервере за ~1–2 минуты.' : 'Изменения сохраняются коммитом в GitHub — сайт пересобирается автоматически за 2–3 минуты.'}</p>
    ${REBUILD ? `<p class="muted" style="margin-top:-6px;font-size:.8rem">Сборка: ${buildState.running ? 'идёт…' : buildState.last ? (buildState.ok ? 'успешно ' : 'ошибка (см. admin/build.log) ') + buildState.last.toLocaleString('ru-RU') : 'ещё не запускалась'}</p>` : ''}
    <div class="grid">${cards}</div>`, req.user, 'dash', req));
});

/* ---------------- список записей ---------------- */
app.get('/c/:name', auth, (req, res) => {
  const cfg = COLLECTIONS[req.params.name];
  if (!cfg) return res.redirect('/');
  const data = readData(cfg.file);
  const btn = (href, text, cls = 'ghost') => `<a class="btn sm ${cls}" href="${href}">${text}</a>`;
  let rows = '';
  if (cfg.nested) {
    data.forEach((cat, ci) => {
      rows += `<tr class="cat"><td colspan="2">${esc(cat.cat)}</td></tr>`;
      (cat.items || []).forEach((item, ii) => {
        const disp = item.name + (item.price ? ` — ${item.price} ₽` : '');
        rows += `<tr><td>${esc(disp)}</td><td style="white-space:nowrap;width:1%;text-align:right">${cfg.readonly ? '' : btn(`/c/${req.params.name}/edit/${ci}.${ii}`, 'Изменить') + ' ' + btn(`/c/${req.params.name}/del/${ci}.${ii}`, '✕', 'red')}</td></tr>`;
      });
    });
  } else if (req.params.name === 'houses') {
    const act = [], arch = [];
    data.forEach((x, i) => (x.archived ? arch : act).push([i, x]));
    rows = act.map(([idx, x]) => `<tr><td>${esc(cfg.display(x))}</td><td style="white-space:nowrap;width:1%;text-align:right">${btn(`/c/houses/edit/${idx}`, 'Изменить') + ' ' + btn(`/c/houses/del/${idx}`, 'В архив', 'red')}</td></tr>`).join('');
    if (arch.length) rows += `<tr class="cat"><td colspan="2">Архив — ушли из управления (${arch.length})</td></tr>` +
      arch.map(([idx, x]) => `<tr style="opacity:.6"><td>${esc(cfg.display(x))}</td><td style="white-space:nowrap;width:1%;text-align:right">${btn(`/c/houses/restore/${idx}`, 'Вернуть из архива')}</td></tr>`).join('');
  } else {
    const list = cfg.dict ? Object.entries(data) : data.map((x, i) => [i, x]);
    list.forEach(([idx, x]) => {
      const disp = cfg.display ? cfg.display(x) : (x.title || x.name || JSON.stringify(x).slice(0, 60));
      rows += `<tr><td>${esc(disp)}</td><td style="white-space:nowrap;width:1%;text-align:right">${cfg.readonly ? '' : btn(`/c/${req.params.name}/edit/${idx}`, 'Изменить') + ' ' + btn(`/c/${req.params.name}/del/${idx}`, '✕', 'red')}</td></tr>`;
    });
  }
  res.send(page(cfg.label, `
    <div class="toolbar">
      <div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg><input id="q" placeholder="Поиск по списку…" oninput="filterRows()"></div>
      ${cfg.readonly ? '' : `<a class="btn" href="/c/${req.params.name}/edit/new">+ Добавить ${esc(cfg.singular || 'запись')}</a>`}
    </div>
    <div class="tblwrap"><table id="tbl"><tbody>${rows || '<tr><td style="padding:16px">пусто</td></tr>'}</tbody></table></div>
    <p class="muted" id="cnt"></p>
    <script>
    const rows=[...document.querySelectorAll('#tbl tbody tr')];
    function filterRows(){const q=document.getElementById('q').value.toLowerCase();let vis=0;
      let lastCat=null;
      for(const r of rows){if(r.classList.contains('cat')){r.dataset.hide='';continue;}
        const hit=!q||r.textContent.toLowerCase().includes(q);r.style.display=hit?'':'none';r.dataset.hit=hit?'1':'';if(hit)vis++;}
      // прячем пустые категории
      let cat=null,any=false;
      for(const r of [...rows].reverse()){if(r.classList.contains('cat')){r.style.display=any?'':'none';any=false;}else if(r.dataset.hit)any=true;}
      if(!q)for(const r of rows)if(r.classList.contains('cat'))r.style.display='';
      document.getElementById('cnt').textContent=q?('Найдено: '+vis):'';
    }
    </script>`, req.user, req.params.name, req));
});

/* ---------------- форма редактирования ---------------- */
// конвертация дат: в базе «ДД.ММ.ГГГГ ЧЧ:ММ» (красиво на сайте), в форме — нативный datetime-local
const toIsoDT = (v) => { const m = String(v || '').match(/^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})/); return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}` : String(v || ''); };
const fromIsoDT = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : String(v || ''); };

let HOUSES_CACHE = null;
let HOUSES_AT = 0;
function houseOptions(current) {
  if (!HOUSES_CACHE || Date.now() - HOUSES_AT > 10 * 60 * 1000) {
    try {
      HOUSES_CACHE = readData('houses.json').filter(h => !h.archived).map(h => `ул. ${h.street}, ${h.num}`).sort((a, b) => a.localeCompare(b, 'ru'));
    } catch { HOUSES_CACHE = []; }
    HOUSES_AT = Date.now();
  }
  return `<option value="">— общий документ (все дома) —</option>` +
    HOUSES_CACHE.map(h => `<option value="${esc(h)}" ${h === current ? 'selected' : ''}>${esc(h)}</option>`).join('');
}

// справочник «улица → номера домов» из полного реестра города (наши + конкуренты, источник mingkh/ГИС ЖКХ)
// кэш на 10 минут — после синка с mingkh/правок домов список подхватится сам
let STREETS_CACHE = null;
let STREETS_AT = 0;
function streetMap() {
  if (STREETS_CACHE && Date.now() - STREETS_AT < 10 * 60 * 1000) return STREETS_CACHE;
  const map = {};
  const add = (street, num) => {
    if (!street || !num) return;
    (map[String(street).trim()] ??= new Set()).add(String(num).trim());
  };
  try { readData('houses_geo.json').forEach(h => add(h.street, h.num)); } catch { }
  try { readData('competitors.json').forEach(h => add(h.street, h.num)); } catch { }
  const nat = (a, b) => a.localeCompare(b, 'ru', { numeric: true });
  STREETS_CACHE = Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => nat(a, b)).map(([s, ns]) => [s, [...ns].sort(nat)])
  );
  STREETS_AT = Date.now();
  return STREETS_CACHE;
}

function fieldHtml(f, val) {
  const v = val ?? f.defaults ?? '';
  if (f.type === 'textarea') return `<textarea name="${esc(f.key)}" ${f.required ? 'required' : ''}>${esc(v)}</textarea>`;
  if (f.type === 'checkbox') return `<label style="display:flex;align-items:center;gap:9px;font-weight:500;margin-top:6px"><input type="checkbox" name="${esc(f.key)}" value="1" style="width:18px;height:18px" ${v ? 'checked' : ''}> да</label>`;
  if (f.type === 'select') return `<select name="${esc(f.key)}">${f.options.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  if (f.type === 'house') return `<select name="${esc(f.key)}">${houseOptions(v)}</select>`;
  if (f.type === 'datetime') return `<input name="${esc(f.key)}" type="datetime-local" value="${esc(toIsoDT(v))}">`;
  if (f.type === 'date') return `<input name="${esc(f.key)}" type="date" value="${esc(String(v || '').slice(0, 10))}">`;
  if (f.type === 'street') {
    const map = streetMap();
    const cur = String(v || '');
    return `<select name="street" id="fld_street">
      <option value="">— выберите улицу —</option>
      ${Object.keys(map).map(s => `<option ${s === cur ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      ${cur && !map[cur] ? `<option selected>${esc(cur)}</option>` : ''}
      <option value="__other">➕ Другая улица (нет в реестре)…</option>
    </select>
    <input name="street_other" id="fld_street_other" placeholder="Название улицы" style="display:none;margin-top:8px">`;
  }
  if (f.type === 'housenum') {
    return `<select name="num" id="fld_num" data-cur="${esc(v || '')}"><option value="">— сначала выберите улицу —</option></select>
    <input name="num_other" id="fld_num_other" placeholder="Номер дома" style="display:none;margin-top:8px">`;
  }
  if (f.type === 'file') return `
    <div class="drop" id="drop">
      <input type="file" id="__file" name="__file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png" style="display:none">
      <div id="drop-txt" style="padding:8px 0">Перетащите файл сюда или <a href="#" onclick="document.getElementById('__file').click();return false">выберите на диске</a><br>
      <span class="muted">PDF, DOCX, XLSX, картинки — до 25 МБ</span></div>
    </div>
    <input type="hidden" name="${esc(f.key)}" id="${esc(f.key)}_url" value="${esc(v)}">
    ${v ? `<p class="muted" style="margin-top:6px">Текущий файл: <a href="https://nextangel-git.github.io${esc(v)}" target="_blank">${esc(v)}</a> — если не выбирать новый, останется он.</p>` : ''}
    <script>
    (function(){const dz=document.getElementById('drop'),fi=document.getElementById('__file'),tx=document.getElementById('drop-txt'),hid=document.getElementById('${esc(f.key)}_url');
      const show=n=>{tx.textContent=n+' — будет загружен при сохранении';dz.style.borderColor='var(--green)';};
      dz.onclick=e=>{if(e.target!==fi)fi.click();};
      fi.onchange=()=>{if(fi.files[0])show(fi.files[0].name)};
      dz.ondragover=e=>{e.preventDefault();dz.style.borderColor='var(--blue2)';dz.style.background='#eff6ff'};
      dz.ondragleave=()=>{dz.style.borderColor='';dz.style.background=''};
      dz.ondrop=e=>{e.preventDefault();if(e.dataTransfer.files[0]){fi.files=e.dataTransfer.files;show(e.dataTransfer.files[0].name)}};
    })();</script>`;
  return `<input name="${esc(f.key)}" type="${f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'}" value="${esc(v)}" ${f.type === 'number' ? 'min="0" step="any"' : ''} ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`;
}

app.get('/c/:name/edit/:idx', auth, (req, res) => {
  const cfg = COLLECTIONS[req.params.name];
  if (!cfg || cfg.readonly) return res.redirect('/');
  const data = readData(cfg.file);
  const isNew = req.params.idx === 'new';
  let rec = null, fields = cfg.fields;
  if (!isNew) {
    rec = recordAt(data, cfg, req.params.idx);
    if (cfg.nested) fields = cfg.itemFields;
    if (rec == null) return res.redirect(`/c/${req.params.name}?err=` + encodeURIComponent('Запись не найдена'));
  } else if (cfg.nested) { fields = cfg.itemFields; }
  if (isNew && cfg.defaults) rec = cfg.defaults();
  if (isNew && cfg.nested) rec = {};
  const keyField = cfg.dict ? `<label>Ключ <span class="hint">латиницей, напр. tariffs</span></label><input name="__key" value="${isNew ? '' : esc(req.params.idx)}" ${isNew ? 'required' : 'readonly'}>` : '';
  const catField = (cfg.nested && isNew) ? `<label>Категория</label><select name="__cat">${data.map((c, i) => `<option value="${i}">${esc(c.cat)}</option>`).join('')}</select>` : '';
  res.send(page((isNew ? 'Новая запись' : 'Изменение') + ' · ' + cfg.label, `
    <div class="card" style="max-width:720px">
    <form method="post" action="/c/${req.params.name}/save/${req.params.idx}" enctype="multipart/form-data">
      <input type="hidden" name="__revision" value="${revision(data)}">
      ${keyField}${catField}
      ${fields.map(f => `<label>${esc(f.label)}${f.required ? ' <span style="color:var(--red)">*</span>' : ''}${f.placeholder ? `<span class="hint">напр. ${esc(f.placeholder)}</span>` : ''}</label>${fieldHtml(f, rec ? rec[f.key] : undefined)}`).join('')}
      <div class="row" style="margin-top:22px"><button class="btn" type="submit">Сохранить</button><a class="btn ghost" href="/c/${req.params.name}">Отмена</a></div>
    </form></div>
    ${req.params.name === 'houses' ? `
    <script>
    (function(){
      const MAP=${JSON.stringify(streetMap()).replace(/</g, '\\u003c')};
      const escapeHtml=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const st=document.getElementById('fld_street'),nm=document.getElementById('fld_num'),
            so=document.getElementById('fld_street_other'),no=document.getElementById('fld_num_other');
      const cur=nm.dataset.cur||'';
      function fillNums(){
        const nums=MAP[st.value]||[];
        let h='<option value="">— выберите номер —</option>';
        if(st.value==='__other'){nm.innerHTML='<option value="__other">Другой номер</option>';nm.value='__other';no.style.display='block';return;}
        no.style.display='none';
        h+=nums.map(n=>'<option '+(n===cur?'selected':'')+'>'+escapeHtml(n)+'</option>').join('');
        if(cur&&!nums.includes(cur)&&cur)h+='<option selected>'+escapeHtml(cur)+'</option>';
        h+='<option value="__other">➕ Другой номер…</option>';
        nm.innerHTML=h;
      }
      st.onchange=()=>{so.style.display=st.value==='__other'?'block':'none';fillNums();};
      nm.onchange=()=>{no.style.display=nm.value==='__other'?'block':'none'};
      if(st.value)fillNums();
    })();
    </script>` : ''}`, req.user, req.params.name, req));
});

app.post('/c/:name/save/:idx', auth, upload.single('__file'), csrf, (req, res) => {
  const cfg = COLLECTIONS[req.params.name];
  if (!cfg || cfg.readonly) return res.redirect('/');
  const data = readData(cfg.file);
  if (!assertRevision(req, res, data)) return;
  const isNew = req.params.idx === 'new';
  const fields = cfg.nested ? cfg.itemFields : cfg.fields;
  const changedPaths = ['src/data/' + cfg.file];
  const previous = isNew ? (cfg.defaults?.() || {}) : recordAt(data, cfg, req.params.idx);
  if (!previous) return res.status(404).send('Запись не найдена');
  let rec = {};
  for (const f of fields) {
    if (f.type === 'checkbox') rec[f.key] = !!req.body[f.key];
    else if (f.type === 'number') rec[f.key] = req.body[f.key] === '' ? null : Number(req.body[f.key]);
    else if (f.type === 'datetime') rec[f.key] = fromIsoDT(req.body[f.key]); // обратно в «ДД.ММ.ГГГГ ЧЧ:ММ»
    else rec[f.key] = String(req.body[f.key] ?? '');
  }
  // загрузка файла: поле типа 'file' — сохраняем в public/documents, url подставляем сами
  const urlField = fields.find(f => f.type === 'file');
  if (req.file && urlField) {
    const dir = DOCUMENTS;
    validateUpload({ name: req.file.originalname, size: req.file.size });
    fs.mkdirSync(dir, { recursive: true });
    const fname = randomUUID() + '-' + safeName(req.file.originalname);
    fs.writeFileSync(path.join(dir, fname), req.file.buffer);
    rec[urlField.key] = '/documents/' + fname;
    changedPaths.push('public/documents/' + fname);
  }
  // формат документа определяем сами из расширения файла/ссылки
  if (urlField && rec[urlField.key]) {
    const e = (rec[urlField.key].split('?')[0].split('.').pop() || '').toUpperCase();
    if (e && e.length <= 5) rec.ext = e;
  }
  // дома: разрешение «другой» улицы/номера и защита от дублей
  if (req.params.name === 'houses') {
    rec.street = (rec.street === '__other' ? String(req.body.street_other || '') : String(rec.street || '')).trim();
    rec.num = (rec.num === '__other' ? String(req.body.num_other || '') : String(rec.num || '')).trim();
    if (!rec.street || !rec.num)
      return res.redirect('/c/houses?err=' + encodeURIComponent('Нужно выбрать улицу и номер дома'));
    const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
    const dupIdx = data.findIndex(h => norm(h.street) === norm(rec.street) && norm(String(h.num)) === norm(rec.num));
    if (dupIdx >= 0 && (isNew || dupIdx !== +req.params.idx))
      return res.redirect('/c/houses?err=' + encodeURIComponent(data[dupIdx].archived
        ? 'Такой дом уже есть в архиве (ушёл из управления) — восстановите его кнопкой «Вернуть» внизу списка'
        : 'Такой дом уже есть в списке'));
    if (isNew && !rec.src) rec.src = 'добавлен вручную через админку';
  }
  // пустые необязательные поля не храним
  try { rec = mergeRecord(previous, rec, fields); }
  catch (err) { return res.status(400).send(esc(err.message)); }
  if (fields.some(f => f.type === 'file') && !rec[fields.find(f => f.type === 'file').key])
    return res.redirect(`/c/${req.params.name}?err=` + encodeURIComponent('Нужно выбрать файл (или у записи должна быть ссылка)'));

  if (cfg.nested) {
    if (isNew) data[+req.body.__cat || 0].items.push(rec);
    else { const [ci, ii] = req.params.idx.split('.').map(Number); data[ci].items[ii] = rec; }
  } else if (cfg.dict) {
    const key = String(req.body.__key || '').trim();
    try { validateKey(key, data, isNew); } catch (err) { return res.status(400).send(esc(err.message)); }
    if (isNew) data[key] = rec; else data[req.params.idx] = rec;
  } else {
    if (isNew) data.push(rec); else data[+req.params.idx] = rec;
  }
  if (req.params.name === 'houses') {
    const geo = updateHouseGeo(isNew ? null : previous, rec, readData('houses_geo.json'), readData('competitors.json'));
    writeData('houses_geo.json', geo);
    changedPaths.push('src/data/houses_geo.json');
    HOUSES_CACHE = null; STREETS_CACHE = null;
  }
  writeData(cfg.file, data);
  const warn = gitSync(`admin: ${isNew ? 'добавлено' : 'изменено'} — ${cfg.label}`, changedPaths);
  const msg = warn || savedText();
  res.redirect(`/c/${req.params.name}?${warn ? 'err' : 'ok'}=` + encodeURIComponent(msg));
});

app.get('/c/:name/del/:idx', auth, (req, res) => {
  const cfg = COLLECTIONS[req.params.name];
  if (!cfg || cfg.readonly) return res.redirect('/');
  const data = readData(cfg.file);
  if (!recordAt(data, cfg, req.params.idx)) return res.status(404).send('Запись не найдена');
  let disp = req.params.idx;
  try {
    if (cfg.nested) { const [ci, ii] = req.params.idx.split('.').map(Number); disp = data[ci].items[ii].name; }
    else disp = cfg.dict ? req.params.idx : cfg.display(data[+req.params.idx]);
  } catch { }
  const isHouse = req.params.name === 'houses';
  res.send(page(isHouse ? 'Перенос дома в архив' : 'Подтверждение удаления', `
    <div class="card" style="max-width:480px">
      <p style="font-size:1.05rem">${isHouse ? 'Перенести в архив дом' : 'Удалить запись'} <b>${esc(disp)}</b>?</p>
      <p class="muted">${isHouse
        ? 'Дом исчезнет с сайта и с карты (ушёл в другую УК), но останется в базе внизу списка. Если дом вернётся к нам — восстановите его кнопкой «Вернуть из архива».'
        : 'Сайт пересоберётся без этой записи. Отменить можно только через git-историю.'}</p>
      <form method="post" action="/c/${req.params.name}/del/${req.params.idx}">
        <input type="hidden" name="__revision" value="${revision(data)}">
        <div class="row" style="margin-top:18px"><button class="btn red" type="submit">${isHouse ? 'Да, в архив' : 'Да, удалить'}</button><a class="btn ghost" href="/c/${req.params.name}">Отмена</a></div>
      </form></div>`, req.user, req.params.name, req));
});

app.post('/c/:name/del/:idx', auth, (req, res) => {
  const cfg = COLLECTIONS[req.params.name];
  if (!cfg || cfg.readonly) return res.redirect('/');
  const data = readData(cfg.file);
  if (!assertRevision(req, res, data)) return;
  if (!recordAt(data, cfg, req.params.idx)) return res.status(404).send('Запись не найдена');
  const changedPaths = ['src/data/' + cfg.file];
  // дома не удаляем — переносим в архив (и помечаем в гео-данных, чтобы исчез с карты)
  if (req.params.name === 'houses') {
    const h = data[+req.params.idx];
    if (h) {
      h.archived = true;
      writeData(cfg.file, data);
      try {
        const geo = readData('houses_geo.json');
        const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
        const g = geo.find(x => norm(x.street) === norm(h.street) && norm(String(x.num)) === norm(String(h.num)));
        if (g) { g.archived = true; writeData('houses_geo.json', geo); changedPaths.push('src/data/houses_geo.json'); }
      } catch { }
    }
    const warn = gitSync(`admin: дом в архив — ${h ? cfg.display(h) : req.params.idx}`, changedPaths);
    return res.redirect(`/c/houses?${warn ? 'err' : 'ok'}=` + encodeURIComponent(warn || 'Дом перенесён в архив. Сайт обновится через ~2–3 минуты.'));
  }
  if (cfg.nested) { const [ci, ii] = req.params.idx.split('.').map(Number); data[ci].items.splice(ii, 1); }
  else if (cfg.dict) delete data[req.params.idx];
  else data.splice(+req.params.idx, 1);
  writeData(cfg.file, data);
  const warn = gitSync(`admin: удалено — ${cfg.label}`, ['src/data/' + cfg.file]);
  res.redirect(`/c/${req.params.name}?${warn ? 'err' : 'ok'}=` + encodeURIComponent(warn || savedText().replace('Сохранено', 'Удалено')));
});

/* ---------------- дома: восстановление из архива ---------------- */
app.get('/c/houses/restore/:idx', auth, (req, res) => {
  const data = readData('houses.json');
  const h = recordAt(data, COLLECTIONS.houses, req.params.idx);
  if (!h) return res.redirect('/c/houses?err=' + encodeURIComponent('Запись не найдена'));
  res.send(page('Восстановление дома', `
    <div class="card" style="max-width:480px">
      <p style="font-size:1.05rem">Вернуть дом <b>ул. ${esc(h.street)}, ${esc(h.num)}</b> из архива?</p>
      <p class="muted">Дом снова появится на сайте, на карте и в поиске — например, дом вернулся в наше управление.</p>
      <form method="post" action="/c/houses/restore/${req.params.idx}">
        <input type="hidden" name="__revision" value="${revision(data)}">
        <div class="row" style="margin-top:18px"><button class="btn" type="submit">Да, вернуть</button><a class="btn ghost" href="/c/houses">Отмена</a></div>
      </form></div>`, req.user, 'houses', req));
});

app.post('/c/houses/restore/:idx', auth, (req, res) => {
  const data = readData('houses.json');
  if (!assertRevision(req, res, data)) return;
  const h = recordAt(data, COLLECTIONS.houses, req.params.idx);
  if (!h) return res.redirect('/c/houses?err=' + encodeURIComponent('Запись не найдена'));
  const changedPaths = ['src/data/houses.json'];
  delete h.archived;
  writeData('houses.json', data);
  try {
    const geo = readData('houses_geo.json');
    const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
    const g = geo.find(x => norm(x.street) === norm(h.street) && norm(String(x.num)) === norm(String(h.num)));
    if (g) { delete g.archived; writeData('houses_geo.json', geo); changedPaths.push('src/data/houses_geo.json'); }
  } catch { }
  const warn = gitSync(`admin: дом возвращён из архива — ул. ${h.street}, ${h.num}`, changedPaths);
  res.redirect(`/c/houses?${warn ? 'err' : 'ok'}=` + encodeURIComponent(warn || 'Дом восстановлен. Сайт обновится через ~2–3 минуты.'));
});

/* ---------------- синхронизация с внешними источниками ---------------- */
const SYNC_OWNER_FILE = TEST_DIR ? path.join(STATE, 'sync-owner.json') : path.resolve(REPO, '..', 'migration', 'sync-owner.json');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const SYNC = {
  mingkh: {
    label: 'Дома и улицы (реестр ГИС ЖКХ)',
    desc: 'Собирает весь реестр домов Сосновоборска с dom.mingkh.ru: новые дома, смена управляющих компаний, характеристики (год постройки, этажи, квартиры, площадь). Если что-то изменилось — сайт пересоберётся сам. Идёт 5–10 минут. Также запускается автоматически 5-го числа каждого месяца.',
    cmd: [PY, '-u', 'mingkh_sync.py'],
    cwd: path.resolve(REPO, '..', 'migration'),
  },
  vk: {
    label: 'Посты VK на главную',
    desc: 'Забирает свежие посты группы vk.ru/ooojks в блок «Новости» на главной странице. Идёт ~1 минуту. Работает, только когда на этом компьютере в браузере Kimi открыта вкладка VK (нужна авторизованная сессия).',
    cmd: [PY, '-u', 'vk_extract.py'],
    cwd: path.resolve(REPO, '..', 'migration'),
  },
};
const syncState = {};

function syncRun(kind) {
  const cfg = SYNC[kind];
  if (!cfg || syncState[kind]?.running) return false;
  const logFile = path.join(STATE, `sync-${kind}.log`);
  const startedAt = new Date();
  syncState[kind] = { running: true, startedAt, exit: null };
  runLogged(cfg.cmd[0], cfg.cmd.slice(1), { cwd: cfg.cwd, logFile,
    onFinish: ({ code, error }) => { syncState[kind] = { running: false, startedAt, exit: code, err: error }; },
  });
  return true;
}

app.get('/sync', auth, (req, res) => {
  const blocked = localSyncBlockReason(SYNC_OWNER_FILE);
  const card = (kind) => {
    const cfg = SYNC[kind];
    const st = syncState[kind] || {};
    let status = 'ещё не запускалась в этой сессии';
    if (st.running) status = `выполняется… (с ${st.startedAt.toLocaleTimeString('ru-RU')})`;
    else if (st.exit === 0) status = 'завершена успешно';
    else if (st.exit != null) status = `завершилась с ошибкой (код ${st.exit}) — смотрите лог`;
    return `<div class="card">
      <h2>${esc(cfg.label)}</h2>
      <p class="muted">${esc(blocked || cfg.desc)}</p>
      <p style="margin:10px 0">Статус: <b>${status}</b></p>
      <form method="post" action="/sync/${kind}" class="row">
        <button class="btn" type="submit" ${st.running || blocked ? 'disabled' : ''}>▶ Запустить сейчас</button>
        <a class="btn ghost" href="/sync-log/${kind}" target="_blank">Открыть лог</a>
      </form></div>`;
  };
  const anyRunning = Object.values(syncState).some(s => s.running);
  res.send(page('Синхронизация', `
    ${anyRunning ? '<meta http-equiv="refresh" content="5">' : ''}
    <p class="muted" style="margin-top:0">${blocked ? esc(blocked) : 'Ручное обновление данных из внешних источников — в любое время, не дожидаясь расписания.'}${anyRunning ? ' Страница обновляется сама каждые 5 секунд.' : ''}</p>
    ${card('mingkh')}${card('vk')}`, req.user, 'sync'));
});

app.post('/sync/:kind', auth, (req, res) => {
  const blocked = localSyncBlockReason(SYNC_OWNER_FILE);
  if (blocked) return res.status(409).send(page('Локальная синхронизация отключена', `<p>${esc(blocked)}</p><p><a href="/sync">Назад к синхронизации</a></p>`, req.user, 'sync'));
  const started = syncRun(req.params.kind);
  res.redirect('/sync?' + (started ? 'ok' : 'err') + '=' + encodeURIComponent(started ? 'Синхронизация запущена' : 'Уже выполняется или неизвестная задача'));
});

app.get('/sync-log/:kind', auth, (req, res) => {
  res.type('text/plain; charset=utf-8');
  try { res.send(fs.readFileSync(path.join(__dirname, `sync-${req.params.kind}.log`), 'utf8')); }
  catch { res.send('(лог пуст — задача ещё не запускалась)'); }
});

/* ---------------- смена своего пароля ---------------- */
app.get('/password', auth, (req, res) => {
  res.send(page('Сменить пароль', `
    <div class="card" style="max-width:460px">
    <form method="post" action="/password">
      <label>Текущий пароль</label><input name="old" type="password" required autocomplete="current-password">
      <label>Новый пароль <span class="hint">минимум 10 символов</span></label><input name="new1" type="password" minlength="10" required autocomplete="new-password">
      <label>Новый пароль ещё раз</label><input name="new2" type="password" minlength="10" required autocomplete="new-password">
      <p style="margin:22px 0 0"><button class="btn" type="submit">Сменить пароль</button></p>
    </form></div>`, req.user, 'password', req));
});

app.post('/password', auth, (req, res) => {
  const { old, new1, new2 } = req.body;
  if (new1 !== new2) return res.redirect('/password?err=' + encodeURIComponent('Новые пароли не совпадают'));
  if (String(new1).length < 10) return res.redirect('/password?err=' + encodeURIComponent('Минимум 10 символов'));
  const users = loadUsers();
  const u = users.find(x => x.login === req.user.login);
  if (!bcrypt.compareSync(String(old || ''), u.passHash)) return res.redirect('/password?err=' + encodeURIComponent('Текущий пароль неверен'));
  u.passHash = bcrypt.hashSync(String(new1), 10); saveUsers(users);
  req.session.authVersion = u.passHash;
  res.redirect('/password?ok=' + encodeURIComponent('Пароль изменён'));
});

/* ---------------- пользователи (только admin) ---------------- */
app.get('/users', auth, adminOnly, (req, res) => {
  const rows = loadUsers().map(u => `<tr><td><b>${esc(u.login)}</b><br><span class="muted">${esc(u.name)}</span></td>
    <td>${u.role === 'admin' ? 'Администратор' : 'Редактор'}</td></tr>`).join('');
  res.send(page('Пользователи', `
    <div class="tblwrap"><table><thead><tr><th>Пользователь</th><th>Роль</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="card" style="margin-top:18px;max-width:720px"><h2>Управление — через консоль сервера</h2>
    <div class="mono">node server.mjs --add-user ivan "Иван (УК)" 'Пароль123!'<br>node server.mjs --passwd ivan 'НовыйПароль'<br></div></div>`, req.user, 'users', req));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err instanceof multer.MulterError ? 400 : err.status || 500).send('Не удалось выполнить операцию. Проверьте поля и допустимый формат файла.');
});

app.listen(PORT, HOST, () => {
  console.log(`Админка ЖКС: http://${HOST}:${PORT}  (${DEV ? 'dev' : 'prod'}, rebuild=${REBUILD ? 'on' : 'off'}, push=${GIT_PUSH ? 'on' : 'off'})`);
  if (!loadUsers().length) console.log('Пользователей нет. Создайте: node server.mjs --add-user <login> "<Имя>" <пароль>');
});
