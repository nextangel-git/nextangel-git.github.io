import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { COLLECTIONS } from '../src/lib/collections.mjs';
import * as dataHelpers from '../src/lib/admin-data.js';

const source = fs.readFileSync(new URL('../src/pages/admin.astro', import.meta.url), 'utf8');
const script = source.match(/<script>\s*([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;\s*$/gm, '');
const baseSource = fs.readFileSync(new URL('../src/layouts/Base.astro', import.meta.url), 'utf8');
const viScript = baseSource.match(/<script>\s*([\s\S]*?)<\/script>/)[1].split('// Мобильное меню')[0];
const styles = source.match(/<style is:global>([\s\S]*?)<\/style>/)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, url = 'https://jks.ooo/admin') {
  const dom = new JSDOM(`<style>${styles}</style><button id="vi-toggle" aria-pressed="false">Версия для слабовидящих</button><div id="vi-panel"><button id="vi-img"></button><button id="vi-off"></button></div><div id="admin-root">Загрузка…</div>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.innerWidth = 390;
  window.TextEncoder = TextEncoder;
  window.structuredClone = structuredClone;
  window.localStorage.setItem('jks_vault', 'old encrypted binding');
  let state = { authenticated: false, user: null, csrf: 'session' };
  const calls = { session: 0, login: [], read: [], password: [], logout: 0 };
  const deps = {
    COLLECTIONS, ...dataHelpers,
    getSessionState: () => ({ ...state }),
    clearSession: () => { state = { authenticated: false, user: null, csrf: '' }; },
    refreshSession: async () => { calls.session++; return { ...state }; },
    login: async (username, password) => {
      calls.login.push({ username, password });
      await tick();
      if (password === 'wrong') throw new Error('Неверный логин или пароль');
      state = { authenticated: true, user: { username, name: 'Редактор' }, csrf: 'authenticated' };
      return { ...state };
    },
    logout: async () => { calls.logout++; state = { authenticated: false, user: null, csrf: '' }; },
    changePassword: async (...args) => { calls.password.push(args); },
    readDataFile: async file => { calls.read.push(file); return { data: file === 'useful.json' ? {} : [], sha: 'sha' }; },
    writeDataFile: () => { throw new Error('Unexpected write'); },
    commitFiles: () => { throw new Error('Unexpected commit'); },
  };
  window.eval(viScript);
  window.__testdeps = deps;
  window.eval(`const { ${Object.keys(deps).join(',')} } = window.__testdeps;\n${script}`);
  await tick();
  return { window, calls };
}

function submit(window, id) {
  window.document.getElementById(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('login form has two labeled password-manager fields; failed login retains legacy binding', async t => {
  const { window, calls } = await setup(t);
  const document = window.document;
  assert.equal(document.querySelectorAll('#admin-login-form input').length, 2);
  assert.equal(document.querySelector('label[for="username"]').textContent, 'Логин');
  assert.equal(document.querySelector('#pass').autocomplete, 'current-password');
  assert.equal(document.querySelector('#username').autocomplete, 'username');
  assert.equal(document.querySelector('#adm-login').type, 'submit');
  assert.doesNotMatch(document.body.textContent, /PAT|токен|капч|первичн/i);
  submit(window, 'admin-login-form');
  assert.equal(calls.login.length, 0);
  document.getElementById('username').value = 'editor';
  document.getElementById('pass').value = 'wrong';
  submit(window, 'admin-login-form');
  await tick(); await tick();
  assert.match(document.getElementById('login-message').textContent, /Неверный/);
  assert.equal(document.getElementById('adm-login').disabled, false);
  assert.equal(window.localStorage.getItem('jks_vault'), 'old encrypted binding');
});

test('double submit is blocked; successful login cleans old binding and logout clears collection cache', async t => {
  const { window, calls } = await setup(t);
  const document = window.document;
  document.getElementById('username').value = 'editor';
  document.getElementById('pass').value = 'correct password';
  submit(window, 'admin-login-form'); submit(window, 'admin-login-form');
  assert.equal(document.getElementById('adm-login').disabled, true);
  await tick(); await tick();
  assert.equal(calls.login.length, 1);
  assert.equal(window.localStorage.getItem('jks_vault'), null);
  assert.match(document.body.textContent, /Дашборд/);
  const reads = calls.read.length;
  assert.ok(reads > 0);
  document.getElementById('adm-exit').click();
  await tick();
  assert.equal(calls.logout, 1);
  assert.ok(document.getElementById('admin-login-form'));
  assert.doesNotMatch(document.body.textContent, /Дашборд/);
  document.getElementById('username').value = 'editor';
  document.getElementById('pass').value = 'correct password';
  submit(window, 'admin-login-form');
  await tick(); await tick();
  assert.equal(calls.read.length, reads * 2);
});

test('GitHub Pages shows the production admin link without requesting a PHP session', async t => {
  const { window, calls } = await setup(t, 'https://nextangel-git.github.io/admin');
  assert.equal(calls.session, 0);
  assert.equal(window.document.querySelector('.authcard a').href, 'https://jks.ooo/admin');
  assert.equal(window.document.querySelectorAll('input').length, 0);
  assert.equal(window.localStorage.getItem('jks_vault'), 'old encrypted binding');
});

test('password form checks confirmation and submits the current/new password to the server', async t => {
  const { window, calls } = await setup(t);
  const document = window.document;
  document.getElementById('username').value = 'editor';
  document.getElementById('pass').value = 'correct password';
  submit(window, 'admin-login-form');
  await tick(); await tick();
  window.location.hash = '#/pass';
  await new Promise(resolve => window.setTimeout(resolve, 10));
  document.getElementById('p0').value = 'old password';
  document.getElementById('p1').value = 'new valid password';
  document.getElementById('p2').value = 'not matching';
  submit(window, 'admin-password-form');
  assert.equal(calls.password.length, 0);
  assert.match(document.getElementById('pass-msg').textContent, /не совпадают/);
  document.getElementById('p1').value = '123456789';
  document.getElementById('p2').value = '123456789';
  submit(window, 'admin-password-form');
  assert.equal(calls.password.length, 0);
  assert.match(document.getElementById('pass-msg').textContent, /Минимум 10/);
  document.getElementById('p1').value = '1234567890';
  document.getElementById('p2').value = '1234567890';
  submit(window, 'admin-password-form');
  await tick();
  assert.deepEqual(calls.password, [['old password', '1234567890']]);
  assert.equal(document.getElementById('p0').value, '');
  assert.equal(document.getElementById('p1').value, '');
  assert.match(document.getElementById('pass-msg').textContent, /Пароль изменён/);
});


test('admin accessibility button delegates to shared VI and stays synchronized through login/logout', async t => {
  const { window } = await setup(t);
  const document = window.document;
  const button = () => document.querySelector('#admin-root [data-admin-vi]');
  assert.equal(window.innerWidth, 390);
  assert.equal(document.querySelectorAll('#vi-toggle').length, 1);
  assert.ok(document.querySelector('.authcard [data-admin-vi]'));
  assert.equal(button().type, 'button');
  assert.equal(button().getAttribute('aria-pressed'), 'false');
  button().click();
  assert.ok(document.documentElement.classList.contains('vi'));
  assert.equal(document.getElementById('vi-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(button().getAttribute('aria-pressed'), 'true');
  assert.equal(button().textContent, 'Обычная версия');
  assert.equal(JSON.parse(window.localStorage.getItem('jks-vi')).on, true);
  const inputStyle = window.getComputedStyle(document.getElementById('pass'));
  assert.equal(inputStyle.color, 'rgb(0, 0, 0)');
  assert.equal(inputStyle.backgroundColor, 'rgb(255, 255, 255)');
  assert.equal(window.getComputedStyle(button()).maxWidth, '100%');
  assert.equal(window.getComputedStyle(button()).whiteSpace, 'normal');
  document.getElementById('username').value = 'editor';
  document.getElementById('pass').value = 'correct password';
  submit(window, 'admin-login-form');
  await tick(); await tick();
  assert.ok(document.querySelector('.pagehead [data-admin-vi]'));
  assert.equal(button().getAttribute('aria-pressed'), 'true');
  button().click();
  assert.equal(document.documentElement.classList.contains('vi'), false);
  assert.equal(button().getAttribute('aria-pressed'), 'false');
  document.getElementById('vi-toggle').click();
  await tick();
  assert.equal(button().getAttribute('aria-pressed'), 'true');
  document.getElementById('adm-exit').click();
  await tick();
  assert.ok(document.querySelector('.authcard [data-admin-vi]'));
  assert.equal(button().getAttribute('aria-pressed'), 'true');
});


test('mobile icon navigation keeps explicit accessible names and tooltips when text is hidden', async t => {
  const { window } = await setup(t);
  const document = window.document;
  document.getElementById('username').value = 'editor';
  document.getElementById('pass').value = 'correct password';
  submit(window, 'admin-login-form');
  await tick(); await tick();
  const links = [...document.querySelectorAll('.snav a')];
  assert.equal(links.length, Object.keys(COLLECTIONS).length + 3);
  for (const link of links) {
    const visibleLabel = link.querySelector('.t').textContent.replace(' ↗', '');
    assert.ok(link.getAttribute('aria-label').includes(visibleLabel));
    assert.equal(link.title, link.getAttribute('aria-label'));
  }
  for (const [name, cfg] of Object.entries(COLLECTIONS)) {
    assert.equal(document.querySelector(`.snav a[href="#/c/${name}"]`).getAttribute('aria-label'), cfg.label);
  }
});
