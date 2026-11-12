// Классическая админка сайта УК «Жилкомсервис».
// Логин/пароль (bcrypt) + TOTP 2FA (Google Authenticator / Яндекс Ключ) + SVG-капча.
// Запись: src/data/*.json → git commit + push → GitHub Actions пересобирают сайт.
// GitHub PAT живёт только здесь, на сервере (в credential manager git) — в браузер не отдаётся.
//
// Запуск:   npm install && npm start          (порт 4777, http://127.0.0.1:4777)
// Добавить пользователя:  node server.mjs --add-user <login> "<Имя>" <пароль>
// Сброс 2FA пользователя: node server.mjs --reset-totp <login>
// Сменить пароль:         node server.mjs --passwd <login> <новый пароль>

import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import svgCaptcha from 'svg-captcha';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COLLECTIONS } from '../src/lib/collections.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const DATA = path.join(REPO, 'src', 'data');
const USERS_FILE = path.join(__dirname, 'users.json');
const PORT = process.env.PORT || 4777;
const HOST = process.env.HOST || '127.0.0.1';
const DEV = process.env.NODE_ENV !== 'production';
// TOTP: принимаем код из соседних 30-секундных окон (рассинхрон часов телефона)
authenticator.options = { window: 1 };
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
  console.log(`Пользователь «${login}» (${name}) создан, роль: ${users[users.length - 1].role}. При первом входе настроит 2FA по QR-коду.`);
  process.exit(0);
}
if (cli[0] === '--reset-totp') {
  const users = loadUsers();
  const u = users.find(x => x.login === cli[1]);
  if (!u) { console.error('Нет такого пользователя'); process.exit(1); }
  u.totpSecret = null; saveUsers(users);
  console.log(`2FA для «${cli[1]}» сброшена — при следующем входе настроит заново.`);
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
const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'jks-admin-' + Math.random().toString(36).slice(2),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: !DEV && process.env.HTTPS === '1', maxAge: 8 * 3600 * 1000 },
}));

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
  if (DEV) console.log(`[dev] капча: ${cap.text}`);
  res.send(authPage('Вход в админку', `
    ${errInline(req)}
    <form method="post" action="/login">
      <label>Логин</label><input name="login" required autocomplete="username" autofocus>
      <label>Пароль</label><input name="password" type="password" required autocomplete="current-password">
      <label>Я не робот <span class="hint">введите символы с картинки</span></label>
      <div class="cap"><span class="capimg">${cap.data}</span><input name="captcha" required autocomplete="off" placeholder="Символы" style="flex:1"></div>
      <p style="margin:22px 0 0"><button class="btn" type="submit" style="width:100%;justify-content:center">Войти</button></p>
    </form>`));
});

app.post('/login', (req, res) => {
  const ip = req.ip;
  if (throttled(ip)) return res.redirect('/login?err=' + encodeURIComponent('Слишком много попыток. Подождите 10 минут.'));
  const { login, password, captcha } = req.body;
  const capOk = captcha && req.session.captcha && captcha.toLowerCase() === req.session.captcha;
  req.session.captcha = null;
  const u = loadUsers().find(x => x.login === String(login || '').trim());
  if (!capOk || !u || !bcrypt.compareSync(String(password || ''), u.passHash)) {
    fail(ip);
    return res.redirect('/login?err=' + encodeURIComponent(!capOk ? 'Неверные символы с картинки' : 'Неверный логин или пароль'));
  }
  okFail(ip);
  req.session.pendingUser = u.login;
  res.redirect(u.totpSecret ? '/totp' : '/setup-totp');
});

app.get('/setup-totp', async (req, res) => {
  if (!req.session.pendingUser) return res.redirect('/login');
  if (!req.session.pendingTotp) req.session.pendingTotp = authenticator.generateSecret();
  const u = loadUsers().find(x => x.login === req.session.pendingUser);
  const url = authenticator.keyuri(u.login, 'ЖКС Админка', req.session.pendingTotp);
  const qr = await QRCode.toDataURL(url, { width: 200, margin: 1 });
  res.send(authPage('Настройка 2FA', `
    <p class="muted">Отсканируйте QR-код приложением <b>Google Authenticator</b>, <b>Яндекс Ключ</b> или любым TOTP-приложением, затем введите 6 цифр из него.</p>
    <p style="text-align:center;margin:14px 0"><img src="${qr}" alt="QR для 2FA" style="border-radius:10px"></p>
    <p class="muted" style="word-break:break-all">Не сканируется? Ключ вручную: <code>${req.session.pendingTotp}</code></p>
    ${errInline(req)}
    <form method="post" action="/setup-totp">
      <label>Код из приложения</label><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code" placeholder="123 456" style="text-align:center;font-size:1.2rem;letter-spacing:.3em">
      <p style="margin:20px 0 0"><button class="btn" type="submit" style="width:100%;justify-content:center">Включить 2FA и войти</button></p>
    </form>`));
});

app.post('/setup-totp', (req, res) => {
  const { pendingUser, pendingTotp } = req.session;
  if (!pendingUser || !pendingTotp) return res.redirect('/login');
  if (!authenticator.check(String(req.body.code || '').replace(/\s/g, ''), pendingTotp))
    return res.redirect('/setup-totp?err=' + encodeURIComponent('Код не подошёл — проверьте время на телефоне и попробуйте ещё раз'));
  const users = loadUsers();
  const u = users.find(x => x.login === pendingUser);
  u.totpSecret = pendingTotp; saveUsers(users);
  delete req.session.pendingTotp;
  req.session.user = u.login;
  res.redirect('/?ok=' + encodeURIComponent('Двухфакторная защита включена. Добро пожаловать!'));
});

app.get('/totp', (req, res) => {
  if (!req.session.pendingUser) return res.redirect('/login');
  res.send(authPage('Код подтверждения', `
    <p class="muted">Введите 6-значный код из приложения (Google Authenticator / Яндекс Ключ).</p>
    ${errInline(req)}
    <form method="post" action="/totp">
      <label>Код из приложения</label><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code" autofocus placeholder="123 456" style="text-align:center;font-size:1.2rem;letter-spacing:.3em">
      <p style="margin:20px 0 0"><button class="btn" type="submit" style="width:100%;justify-content:center">Подтвердить</button></p>
    </form>`));
});

app.post('/totp', (req, res) => {
  const ip = req.ip;
  if (throttled(ip)) return res.redirect('/login?err=' + encodeURIComponent('Слишком много попыток. Подождите 10 минут.'));
  const u = loadUsers().find(x => x.login === req.session.pendingUser);
  if (!u) return res.redirect('/login');
  if (!authenticator.check(String(req.body.code || '').replace(/\s/g, ''), u.totpSecret)) {
    fail(ip);
    if (DEV) console.log(`[dev] totp FAIL: got="${req.body.code}" expected="${authenticator.generate(u.totpSecret)}" user=${u.login} pending=${req.session.pendingUser}`);
    return res.redirect('/totp?err=' + encodeURIComponent('Неверный код'));
  }
  okFail(ip);
  req.session.user = u.login;
  res.redirect('/');
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

/* ---------------- auth middleware ---------------- */
function auth(req, res, next) {
  const u = loadUsers().find(x => x.login === req.session.user);
  if (!u) return res.redirect('/login');
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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 МБ на документ
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
const writeData = (file, data) => fs.writeFileSync(path.join(DATA, file), JSON.stringify(data, null, 1) + '\n');

let buildState = { running: false, last: null, ok: null };
let buildTimer = null;
function scheduleRebuild() {
  if (!REBUILD) return;
  clearTimeout(buildTimer);
  buildTimer = setTimeout(() => {
    if (buildState.running) { scheduleRebuild(); return; } // подождём окончания текущей сборки
    buildState = { running: true, last: new Date(), ok: null };
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const p = spawn(npm, ['run', 'build'], { cwd: REPO, shell: false });
    const log = fs.createWriteStream(path.join(__dirname, 'build.log'));
    p.stdout.pipe(log); p.stderr.pipe(log);
    p.on('close', (code) => { buildState = { running: false, last: new Date(), ok: code === 0 }; });
  }, 5000); // дебаунс 5 сек — серия правок = одна сборка
}

function gitSync(message) {
  try {
    execFileSync('git', ['add', 'src/data', 'public/documents'], { cwd: REPO, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', message], { cwd: REPO, stdio: 'pipe' });
    if (GIT_PUSH) execFileSync('git', ['push', 'origin', 'main'], { cwd: REPO, stdio: 'pipe', timeout: 60000 });
    scheduleRebuild();
    return null;
  } catch (e) {
    const out = String(e.stderr || e.message || '');
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
let HOUSES_CACHE = null;
function houseOptions(current) {
  if (!HOUSES_CACHE) {
    try {
      HOUSES_CACHE = readData('houses.json').map(h => `ул. ${h.street}, ${h.num}`).sort((a, b) => a.localeCompare(b, 'ru'));
    } catch { HOUSES_CACHE = []; }
  }
  return `<option value="">— общий документ (все дома) —</option>` +
    HOUSES_CACHE.map(h => `<option value="${esc(h)}" ${h === current ? 'selected' : ''}>${esc(h)}</option>`).join('');
}

function fieldHtml(f, val) {
  const v = val ?? f.defaults ?? '';
  if (f.type === 'textarea') return `<textarea name="${esc(f.key)}">${esc(v)}</textarea>`;
  if (f.type === 'checkbox') return `<label style="display:flex;align-items:center;gap:9px;font-weight:500;margin-top:6px"><input type="checkbox" name="${esc(f.key)}" value="1" style="width:18px;height:18px" ${v ? 'checked' : ''}> да</label>`;
  if (f.type === 'select') return `<select name="${esc(f.key)}">${f.options.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  if (f.type === 'house') return `<select name="${esc(f.key)}">${houseOptions(v)}</select>`;
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
      const show=n=>{tx.innerHTML='<b>'+n+'</b><br><span class="muted">будет загружен при сохранении</span>';dz.style.borderColor='var(--green)';};
      dz.onclick=()=>fi.click();
      fi.onchange=()=>{if(fi.files[0])show(fi.files[0].name)};
      dz.ondragover=e=>{e.preventDefault();dz.style.borderColor='var(--blue2)';dz.style.background='#eff6ff'};
      dz.ondragleave=()=>{dz.style.borderColor='';dz.style.background=''};
      dz.ondrop=e=>{e.preventDefault();if(e.dataTransfer.files[0]){fi.files=e.dataTransfer.files;show(e.dataTransfer.files[0].name)}};
    })();</script>`;
  return `<input name="${esc(f.key)}" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(v)}" ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`;
}

app.get('/c/:name/edit/:idx', auth, (req, res) => {
  const cfg = COLLECTIONS[req.params.name];
  if (!cfg || cfg.readonly) return res.redirect('/');
  const data = readData(cfg.file);
  const isNew = req.params.idx === 'new';
  let rec = null, fields = cfg.fields;
  if (!isNew) {
    if (cfg.nested) { const [ci, ii] = req.params.idx.split('.').map(Number); rec = data[ci]?.items?.[ii]; fields = cfg.itemFields; }
    else if (cfg.dict) rec = data[req.params.idx];
    else rec = data[+req.params.idx];
    if (rec == null) return res.redirect(`/c/${req.params.name}?err=` + encodeURIComponent('Запись не найдена'));
  } else if (cfg.nested) { fields = cfg.itemFields; }
  if (isNew && cfg.defaults) rec = cfg.defaults();
  if (isNew && cfg.nested) rec = {};
  const keyField = cfg.dict ? `<label>Ключ <span class="hint">латиницей, напр. tariffs</span></label><input name="__key" value="${isNew ? '' : esc(req.params.idx)}" ${isNew ? 'required' : 'readonly'}>` : '';
  const catField = (cfg.nested && isNew) ? `<label>Категория</label><select name="__cat">${data.map((c, i) => `<option value="${i}">${esc(c.cat)}</option>`).join('')}</select>` : '';
  res.send(page((isNew ? 'Новая запись' : 'Изменение') + ' · ' + cfg.label, `
    <div class="card" style="max-width:720px">
    <form method="post" action="/c/${req.params.name}/save/${req.params.idx}" enctype="multipart/form-data">
      ${keyField}${catField}
      ${fields.map(f => `<label>${esc(f.label)}${f.required ? ' <span style="color:var(--red)">*</span>' : ''}${f.placeholder ? `<span class="hint">напр. ${esc(f.placeholder)}</span>` : ''}</label>${fieldHtml(f, rec ? rec[f.key] : undefined)}`).join('')}
      <div class="row" style="margin-top:22px"><button class="btn" type="submit">Сохранить</button><a class="btn ghost" href="/c/${req.params.name}">Отмена</a></div>
    </form></div>`, req.user, req.params.name, req));
});

app.post('/c/:name/save/:idx', auth, upload.single('__file'), (req, res) => {
  const cfg = COLLECTIONS[req.params.name];
  if (!cfg || cfg.readonly) return res.redirect('/');
  const data = readData(cfg.file);
  const isNew = req.params.idx === 'new';
  const fields = cfg.nested ? cfg.itemFields : cfg.fields;
  const rec = {};
  for (const f of fields) {
    if (f.type === 'checkbox') rec[f.key] = !!req.body[f.key];
    else if (f.type === 'number') rec[f.key] = req.body[f.key] === '' ? null : Number(req.body[f.key]);
    else rec[f.key] = String(req.body[f.key] ?? '');
  }
  // загрузка файла: поле типа 'file' — сохраняем в public/documents, url подставляем сами
  const urlField = fields.find(f => f.type === 'file');
  if (req.file && urlField) {
    const dir = path.join(REPO, 'public', 'documents');
    fs.mkdirSync(dir, { recursive: true });
    let fname = safeName(req.file.originalname);
    while (fs.existsSync(path.join(dir, fname))) fname = fname.replace(/(\.[^.]+)$/, `-${Date.now() % 100000}$1`);
    fs.writeFileSync(path.join(dir, fname), req.file.buffer);
    rec[urlField.key] = '/documents/' + fname;
  }
  // формат документа определяем сами из расширения файла/ссылки
  if (urlField && rec[urlField.key]) {
    const e = (rec[urlField.key].split('?')[0].split('.').pop() || '').toUpperCase();
    if (e && e.length <= 5) rec.ext = e;
  }
  // пустые необязательные поля не храним
  for (const k of Object.keys(rec)) if (rec[k] === '' || rec[k] === null) delete rec[k];
  if (fields.some(f => f.type === 'file') && !rec[fields.find(f => f.type === 'file').key])
    return res.redirect(`/c/${req.params.name}?err=` + encodeURIComponent('Нужно выбрать файл (или у записи должна быть ссылка)'));
  if (isNew && cfg.defaults && !cfg.nested) Object.assign(rec, cfg.defaults(), rec);
  if (cfg.nested) {
    if (isNew) data[+req.body.__cat || 0].items.push(rec);
    else { const [ci, ii] = req.params.idx.split('.').map(Number); data[ci].items[ii] = rec; }
  } else if (cfg.dict) {
    const key = String(req.body.__key || '').trim();
    if (isNew && !key) return res.redirect(`/c/${req.params.name}?err=` + encodeURIComponent('Нужен ключ'));
    if (isNew) data[key] = rec; else data[req.params.idx] = rec;
  } else {
    if (isNew) data.push(rec); else data[+req.params.idx] = rec;
  }
  writeData(cfg.file, data);
  const warn = gitSync(`admin: ${isNew ? 'добавлено' : 'изменено'} — ${cfg.label}`);
  const msg = warn || savedText();
  res.redirect(`/c/${req.params.name}?${warn ? 'err' : 'ok'}=` + encodeURIComponent(msg));
});

app.get('/c/:name/del/:idx', auth, (req, res) => {
  const cfg = COLLECTIONS[req.params.name];
  if (!cfg || cfg.readonly) return res.redirect('/');
  const data = readData(cfg.file);
  let disp = req.params.idx;
  try {
    if (cfg.nested) { const [ci, ii] = req.params.idx.split('.').map(Number); disp = data[ci].items[ii].name; }
    else disp = cfg.dict ? req.params.idx : cfg.display(data[+req.params.idx]);
  } catch { }
  res.send(page('Подтверждение удаления', `
    <div class="card" style="max-width:480px">
      <p style="font-size:1.05rem">Удалить запись <b>${esc(disp)}</b>?</p>
      <p class="muted">Сайт пересоберётся без этой записи. Отменить можно только через git-историю.</p>
      <form method="post" action="/c/${req.params.name}/del/${req.params.idx}">
        <div class="row" style="margin-top:18px"><button class="btn red" type="submit">Да, удалить</button><a class="btn ghost" href="/c/${req.params.name}">Отмена</a></div>
      </form></div>`, req.user, req.params.name, req));
});

app.post('/c/:name/del/:idx', auth, (req, res) => {
  const cfg = COLLECTIONS[req.params.name];
  if (!cfg || cfg.readonly) return res.redirect('/');
  const data = readData(cfg.file);
  if (cfg.nested) { const [ci, ii] = req.params.idx.split('.').map(Number); data[ci].items.splice(ii, 1); }
  else if (cfg.dict) delete data[req.params.idx];
  else data.splice(+req.params.idx, 1);
  writeData(cfg.file, data);
  const warn = gitSync(`admin: удалено — ${cfg.label}`);
  res.redirect(`/c/${req.params.name}?${warn ? 'err' : 'ok'}=` + encodeURIComponent(warn || savedText().replace('Сохранено', 'Удалено')));
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
  res.redirect('/password?ok=' + encodeURIComponent('Пароль изменён'));
});

/* ---------------- пользователи (только admin) ---------------- */
app.get('/users', auth, adminOnly, (req, res) => {
  const rows = loadUsers().map(u => `<tr><td><b>${esc(u.login)}</b><br><span class="muted">${esc(u.name)}</span></td>
    <td>${u.role === 'admin' ? 'Администратор' : 'Редактор'}</td>
    <td>${u.totpSecret ? '<span class="badge">2FA включена</span>' : '<span class="badge off">2FA не настроена</span>'}</td></tr>`).join('');
  res.send(page('Пользователи', `
    <div class="tblwrap"><table><thead><tr><th>Пользователь</th><th>Роль</th><th>2FA</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="card" style="margin-top:18px;max-width:720px"><h2>Управление — через консоль сервера</h2>
    <div class="mono">node server.mjs --add-user ivan "Иван (УК)" 'Пароль123!'<br>node server.mjs --passwd ivan 'НовыйПароль'<br>node server.mjs --reset-totp ivan</div></div>`, req.user, 'users', req));
});

app.listen(PORT, HOST, () => {
  console.log(`Админка ЖКС: http://${HOST}:${PORT}  (${DEV ? 'dev' : 'prod'}, rebuild=${REBUILD ? 'on' : 'off'}, push=${GIT_PUSH ? 'on' : 'off'})`);
  if (!loadUsers().length) console.log('Пользователей нет. Создайте: node server.mjs --add-user <login> "<Имя>" <пароль>');
});
