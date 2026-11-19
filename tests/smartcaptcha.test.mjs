import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountSmartCaptcha, SMARTCAPTCHA_SITEKEY } from '../src/lib/smartcaptcha.js';
import { mockSmartCaptcha } from './helpers/smartcaptcha.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  const dom = new JSDOM('<div id="widget"></div>', { url: 'https://jks.ooo/request' });
  t.after(() => dom.window.close());
  return { window: dom.window, container: dom.window.document.getElementById('widget') };
}

test('visible Russian widget clears expired/error tokens, retries and releases subscriptions', async t => {
  const { window, container } = setup(t);
  const vendor = mockSmartCaptcha(window);
  const changes = [];
  const captcha = mountSmartCaptcha(container, token => changes.push(token));
  await tick();
  const options = vendor.last().options;
  assert.equal(options.sitekey, SMARTCAPTCHA_SITEKEY);
  assert.equal(options.invisible, false);
  assert.equal(options.hl, 'ru');
  assert.notEqual(options.hideShield, true);
  vendor.solve('valid-token');
  assert.equal(captcha.token, 'valid-token');
  vendor.emit('token-expired');
  assert.equal(captcha.token, '');
  assert.match(container.textContent, /Срок проверки истёк/);
  vendor.solve(); vendor.emit('network-error');
  assert.equal(captcha.token, '');
  assert.equal(container.querySelector('button').hidden, false);
  container.querySelector('button').click(); await tick();
  assert.equal(vendor.calls.destroy.length, 1);
  vendor.solve(); captcha.reset();
  assert.equal(captcha.token, '');
  assert.equal(vendor.calls.reset.length, 1);
  vendor.solve(); vendor.emit('javascript-error');
  assert.equal(captcha.token, '');
  captcha.destroy();
  options.callback('late-token');
  assert.equal(captcha.token, '');
  assert.equal(vendor.widgets.size, 0);
  assert.equal(changes.at(-1), '');
});

test('script load failure is visible and retry uses the official loader without network in tests', async t => {
  const { window, container } = setup(t);
  const captcha = mountSmartCaptcha(container);
  let script = window.document.querySelector('script');
  const url = new URL(script.src);
  assert.equal(url.origin, 'https://smartcaptcha.cloud.yandex.ru');
  assert.equal(url.pathname, '/captcha.js');
  assert.equal(url.searchParams.get('render'), 'onload');
  script.dispatchEvent(new window.Event('error')); await tick();
  assert.equal(captcha.token, '');
  assert.match(container.textContent, /недоступна/);
  container.querySelector('button').click();
  script = window.document.querySelector('script');
  const vendor = mockSmartCaptcha(window);
  window[new URL(script.src).searchParams.get('onload')](); await tick();
  vendor.solve();
  assert.equal(captcha.token, 'mock-one-use-token');
  captcha.destroy();
});
