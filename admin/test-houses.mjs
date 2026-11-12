// Сквозной тест админки: вход → проверка формы дома → дубль → добавление → архив → возврат
import fs from 'node:fs';
import { authenticator } from 'otplib';

const base = 'http://127.0.0.1:4777';
let cookie = '';
const grab = (r) => { (r.headers.getSetCookie?.() || []).forEach(c => { cookie = c.split(';')[0]; }); };

// вход
let r = await fetch(base + '/login'); grab(r); await r.text();
await new Promise(s => setTimeout(s, 300));
const log = fs.readFileSync('admin_test.log', 'utf8').trim().split('\n');
const cap = log[log.length - 1].split('капча: ')[1];
r = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ login: 'denis', password: 'Jks-0M88CFIZ', captcha: cap }), redirect: 'manual' });
grab(r);
const u = JSON.parse(fs.readFileSync('users.json', 'utf8')).find(x => x.login === 'denis');
r = await fetch(base + '/totp', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie }, body: 'code=' + authenticator.generate(u.totpSecret), redirect: 'manual' });
grab(r);
console.log('1. вход:', r.headers.get('location') === '/' ? 'OK' : 'FAIL ' + r.headers.get('location'));

// форма нового дома: есть ли каскадные списки
r = await fetch(base + '/c/houses/edit/new', { headers: { cookie } });
const html = await r.text();
console.log('2. форма: список улиц =', html.includes('fld_street') ? 'OK' : 'FAIL', ', номеров =', html.includes('fld_num') ? 'OK' : 'FAIL', ', «другая улица» =', html.includes('__other') ? 'OK' : 'FAIL');

// дубль: дом, который уже есть
const houses = JSON.parse(fs.readFileSync('../src/data/houses.json', 'utf8'));
const first = houses[0];
r = await fetch(base + '/c/houses/save/new', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ street: first.street, num: String(first.num) }), redirect: 'manual' });
console.log('3. дубль отклонён:', decodeURIComponent(r.headers.get('location') || '').includes('уже есть') ? 'OK' : 'FAIL ' + r.headers.get('location'));

// добавление нового дома (дом конкурента — «вернулся к нам»)
const n0 = houses.length;
r = await fetch(base + '/c/houses/save/new', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ street: '9-й Пятилетки', num: '5' }), redirect: 'manual' });
let h2 = JSON.parse(fs.readFileSync('../src/data/houses.json', 'utf8'));
console.log('4. добавление:', h2.length === n0 + 1 ? 'OK' : 'FAIL', '—', h2[h2.length - 1].street, h2[h2.length - 1].num, '| src:', h2[h2.length - 1].src);

// архив
const idx = h2.length - 1;
r = await fetch(base + `/c/houses/del/${idx}`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
h2 = JSON.parse(fs.readFileSync('../src/data/houses.json', 'utf8'));
const geo = JSON.parse(fs.readFileSync('../src/data/houses_geo.json', 'utf8'));
const g = geo.find(x => x.street === '9-й Пятилетки' && x.num === '5');
console.log('5. архив: флаг в houses =', h2[idx].archived === true ? 'OK' : 'FAIL', '| в houses_geo =', g && g.archived === true ? 'OK' : (g ? 'FAIL' : 'OK (дома нет в гео)'));

// дубль против архивного
r = await fetch(base + '/c/houses/save/new', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ street: '9-й Пятилетки', num: '5' }), redirect: 'manual' });
console.log('6. дубль архивного:', decodeURIComponent(r.headers.get('location') || '').includes('архиве') ? 'OK' : 'FAIL ' + r.headers.get('location'));

// возврат из архива
r = await fetch(base + `/c/houses/restore/${idx}`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
h2 = JSON.parse(fs.readFileSync('../src/data/houses.json', 'utf8'));
console.log('7. возврат:', h2[idx].archived === undefined ? 'OK' : 'FAIL');

// чистим за собой: удаляем добавленный дом (он тестовый, настоящего дома у нас нет)
h2.splice(idx, 1);
fs.writeFileSync('../src/data/houses.json', JSON.stringify(h2, null, 1) + '\n');
console.log('8. тестовый дом убран, домов:', h2.length);

// список домов в админке рендерится
r = await fetch(base + '/c/houses', { headers: { cookie } });
const lst = await r.text();
console.log('9. список домов:', lst.includes('9-й Пятилетки') ? 'OK' : 'FAIL');
