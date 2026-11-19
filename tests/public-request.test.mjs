import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { mountSmartCaptcha } from '../src/lib/smartcaptcha.js';
import { mockSmartCaptcha } from './helpers/smartcaptcha.mjs';

// Exercise the actual form and event handlers in memory. No browser or network is used.
const source = fs.readFileSync(new URL('../src/pages/request.astro', import.meta.url), 'utf8');
const script = source.match(/<script>\s*([\s\S]*?)<\/script>/)[1]
  .replace(/^\s*import .*;$/gm, '');
const markup = source.replace(/^---[\s\S]*?---/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '');

async function setup(t, fetchImpl, url = 'https://example.test/request') {
  const dom = new JSDOM(markup, { url, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.housesAll = [{ street: 'Тестовая', num: '1' }];
  const captcha = mockSmartCaptcha(w);
  w.mountSmartCaptcha = mountSmartCaptcha;
  w.fetch = fetchImpl;
  w.AbortSignal = AbortSignal;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(script);
  await new Promise(resolve => setImmediate(resolve));
  if (captcha.widgets.size) captcha.solve();
  const form = w.document.getElementById('request-form');
  for (const [name, value] of Object.entries({ fio: 'Тест формы', phone: '+7 999 000 00 00', house: 'ул. Тестовая, 1', flat: ' 17 ', text: 'Изолированная проверка — не отправляется', topic: 'Другое' })) form.elements[name].value = value;
  form.elements.pdn.checked = true;
  return { w, form, captcha, submit: () => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })) };
}

async function settled(w) {
  for (let i = 0; i < 50; i++) {
    if (!w.document.getElementById('request-done').hidden) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Form did not finish the mocked request');
}

test('uninitialized form cannot expose personal data through a native GET submission', t => {
  const dom = new JSDOM(markup, { url: 'https://example.test/request', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const form = w.document.getElementById('request-form');
  form.elements.fio.value = 'Приватные данные';
  form.elements.phone.value = '+79990000000';
  form.elements.text.value = 'Не должно отправляться без обработчика';
  assert.equal(form.hidden, true);
  assert.equal(form.method, 'post');
  assert.equal(w.document.getElementById('request-fields').disabled, true);
  assert.equal(form.elements.fio.matches(':disabled'), true);
  assert.deepEqual([...new w.FormData(form)], []);
  assert.equal(w.document.getElementById('request-unavailable').hidden, false);
});

test('successful initialization enables the fields and removes the fallback message', async t => {
  const { w, form } = await setup(t, () => { throw new Error('No request expected'); });
  assert.equal(form.hidden, false);
  assert.equal(w.document.getElementById('request-fields').disabled, false);
  assert.equal(form.elements.fio.matches(':disabled'), false);
  assert.equal(w.document.getElementById('request-unavailable').hidden, true);
});

test('form posts only once to the same-origin gateway and reports service acceptance honestly', async t => {
  const calls = [];
  let resolve;
  const response = new Promise(r => { resolve = r; });
  const { w, form, submit } = await setup(t, (...args) => { calls.push(args); return response; });
  submit(); submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/request.php');
  assert.equal(JSON.parse(calls[0][1].body).house, 'ул. Тестовая, 1');
  assert.equal(form.querySelector('[type=submit]').disabled, true);
  resolve({ ok: true, json: async () => ({ success: true, requestId: JSON.parse(calls[0][1].body).requestId }) });
  await settled(w);
  assert.equal(form.hidden, true);
  assert.equal(w.document.getElementById('request-mailto').hidden, true);
  assert.match(w.document.getElementById('request-heading').textContent, /Сервис принял/);
  assert.match(w.document.getElementById('request-done').textContent, /не регистрирует заявку/);
});

test('invalid or unconsented forms and honeypot never call the network', async t => {
  let calls = 0;
  const { form, submit } = await setup(t, () => { calls++; throw new Error('Unexpected network'); });
  form.elements.pdn.checked = false; submit();
  form.elements.pdn.checked = true; form.elements.phone.value = '123'; submit();
  form.elements.phone.value = '+79990000000'; form.elements.fio.value = '   '; submit();
  form.elements.fio.value = 'Тест'; form.elements.company.value = 'bot'; submit();
  assert.equal(calls, 0);
  assert.equal(form.hidden, false);
});

for (const failure of ['network', 'service']) {
  test(`${failure} failure preserves the letter and supports an explicit retry`, async t => {
    const { w, form, submit } = await setup(t, async () => {
      if (failure === 'network') throw new Error('Offline');
      return { ok: true, json: async () => ({ success: false }) };
    });
    const original = form.elements.text.value;
    submit(); await settled(w);
    const mail = w.document.getElementById('request-mailto');
    assert.equal(mail.hidden, false);
    assert.ok(mail.href.startsWith('mailto:uk@jks.ooo?'));
    assert.match(w.document.getElementById('request-heading').textContent, /не подтверждена/);
    assert.ok(w.document.getElementById('request-copy-text').value.includes(original));
    w.document.getElementById('request-back').click();
    assert.equal(form.hidden, false);
    assert.equal(form.elements.text.value, original);
    assert.equal(form.querySelector('[type=submit]').disabled, true);
    assert.equal(w.document.getElementById('request-done').hidden, true);
  });
}


test('blank apartment and expired CAPTCHA are rejected; 403 keeps fields for a fresh attempt', async t => {
  const calls = [];
  const { w, form, captcha, submit } = await setup(t, async (...args) => {
    calls.push(args);
    return { status: 403, ok: false, json: async () => ({ error: 'captcha_invalid', message: 'Пройдите проверку снова.' }) };
  });
  form.elements.flat.value = '   ';
  submit(); assert.equal(calls.length, 0);
  form.elements.flat.value = ' 17 ';
  captcha.emit('token-expired');
  submit(); assert.equal(calls.length, 0);
  captcha.solve('fresh-request-token');
  submit(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0][1].body);
  assert.equal(payload.flat, '17');
  assert.equal(payload.captchaToken, 'fresh-request-token');
  assert.equal(payload.pdn, true);
  assert.equal(payload.company, '');
  assert.match(payload.requestId, /^ЖКС-/);
  assert.equal(form.hidden, false);
  assert.equal(w.document.getElementById('request-done').hidden, true);
  assert.match(w.document.getElementById('request-error').textContent, /снова/);
  assert.equal(form.elements.flat.value, ' 17 ');
  assert.equal(captcha.calls.reset.length, 1);
  submit(); assert.equal(calls.length, 1);
});

test('GitHub Pages does not initialize a widget or send a request and links to production', async t => {
  const { w, form, captcha } = await setup(t, () => assert.fail('Unexpected network'), 'https://nextangel-git.github.io/request');
  assert.equal(form.hidden, true);
  assert.equal(captcha.widgets.size, 0);
  assert.equal(w.document.querySelector('#request-unavailable a').href, 'https://jks.ooo/request');
});
