// Тест страницы синхронизации
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

r = await fetch(base + '/sync', { headers: { cookie } });
const html = await r.text();
console.log('2. страница /sync:', html.includes('ГИС ЖКХ') && html.includes('vk.ru/ooojks') ? 'OK' : 'FAIL', '| кнопки:', (html.match(/Запустить сейчас/g) || []).length);
console.log('3. ссылка в меню:', html.includes('Синхронизация') ? 'OK' : 'FAIL');

// запускаем mingkh-синк
r = await fetch(base + '/sync/mingkh', { method: 'POST', headers: { cookie }, redirect: 'manual' });
console.log('4. запуск mingkh:', (r.headers.get('location') || '').includes('ok=') ? 'OK' : 'FAIL');

await new Promise(s => setTimeout(s, 3000));
r = await fetch(base + '/sync', { headers: { cookie } });
const h2 = await r.text();
console.log('5. статус «выполняется»:', h2.includes('выполняется') ? 'OK' : 'FAIL');

// повторный запуск во время работы — отказ
r = await fetch(base + '/sync/mingkh', { method: 'POST', headers: { cookie }, redirect: 'manual' });
console.log('6. дабл-запуск отклонён:', decodeURIComponent(r.headers.get('location') || '').includes('Уже выполняется') ? 'OK' : 'FAIL');
