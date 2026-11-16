// Тест полей-календарей в отключениях (datetime-local/date <-> «ДД.ММ.ГГГГ ЧЧ:ММ»)
import fs from 'node:fs';
import { authenticator } from 'otplib';
authenticator.options = { window: 1 };

const base = 'http://127.0.0.1:4777';
let cookie = '';
const grab = (r) => { (r.headers.getSetCookie?.() || []).forEach(c => { cookie = c.split(';')[0]; }); };

let r = await fetch(base + '/login'); grab(r); await r.text();
await new Promise(s => setTimeout(s, 300));
const log = fs.readFileSync('admin_test.log', 'utf8').trim().split('\n');
const cap = log[log.length - 1].split('капча: ')[1];
r = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ login: 'denis', password: 'Jks-0M88CFIZ', captcha: cap }), redirect: 'manual' }); grab(r);
const u = JSON.parse(fs.readFileSync('users.json', 'utf8')).find(x => x.login === 'denis');
r = await fetch(base + '/totp', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie }, body: 'code=' + authenticator.generate(u.totpSecret), redirect: 'manual' }); grab(r);
console.log('1. вход:', r.headers.get('location') === '/' ? 'OK' : 'FAIL');

r = await fetch(base + '/c/shutdowns/edit/new', { headers: { cookie } });
const html = await r.text();
console.log('2. datetime-local:', (html.match(/type="datetime-local"/g) || []).length === 2 ? 'OK x2' : 'FAIL', '| date:', html.includes('type="date"') ? 'OK' : 'FAIL');

const fd = new FormData();
fd.append('what', 'Тестовое отключение (удалить)');
fd.append('where', 'ул. Тестовая, 1');
fd.append('from', '2026-11-20T09:00');
fd.append('to', '2026-11-20T18:30');
fd.append('reason', 'Тест');
fd.append('until', '2026-11-21');
fd.append('active', '1');
r = await fetch(base + '/c/shutdowns/save/new', { method: 'POST', headers: { cookie }, body: fd, redirect: 'manual' });
console.log('3. сохранение:', (r.headers.get('location') || '').includes('ok=') ? 'OK' : 'FAIL ' + r.headers.get('location'));

const sh = JSON.parse(fs.readFileSync('../src/data/shutdowns.json', 'utf8'));
const last = sh[sh.length - 1];
console.log('4. формат в базе:', last.from === '20.11.2026 09:00' && last.to === '20.11.2026 18:30' && last.until === '2026-11-21' ? 'OK' : 'FAIL', JSON.stringify({ from: last.from, to: last.to, until: last.until }));

r = await fetch(base + '/c/shutdowns/edit/' + (sh.length - 1), { headers: { cookie } });
const eh = await r.text();
console.log('5. редактирование показывает ISO:', eh.includes('2026-11-20T09:00') ? 'OK' : 'FAIL');

r = await fetch(base + '/c/shutdowns/del/' + (sh.length - 1), { method: 'POST', headers: { cookie }, redirect: 'manual' });
const sh2 = JSON.parse(fs.readFileSync('../src/data/shutdowns.json', 'utf8'));
console.log('6. удалено:', sh2.length === sh.length - 1 ? 'OK' : 'FAIL', '| осталось:', sh2.length);
