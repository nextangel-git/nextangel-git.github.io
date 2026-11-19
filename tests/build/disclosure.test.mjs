import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { initGisSearch } from '../../src/lib/gis-search.js';

const read = name => fs.readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const houses = JSON.parse(read('src/data/houses.json')).filter(h => !h.archived);
const links = JSON.parse(read('src/data/gis-links.json'));
const html = read('dist/disclosure/index.html');

test('disclosure serves each approved address and matching official house links without JavaScript', () => {
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll('.gis-house').length, houses.length);
  const ids = new Set();
  for (const h of houses) {
    const matches = links.houses.filter(g => g.street === h.street && g.num === h.num);
    assert.ok(matches.length <= 1, `${h.street}, ${h.num}`);
    if (!matches.length) {
      const row = [...doc.querySelectorAll('.gis-house')].find(r => r.dataset.street === h.street && r.dataset.num === h.num);
      assert.equal(row.querySelector('a').href, links.housesUrl, 'New addresses keep a working registry fallback');
      continue;
    }
    const g = matches[0];
    const manage = new URL(g.managementUrl), card = new URL(g.houseUrl);
    assert.equal(manage.origin, 'https://dom.gosuslugi.ru');
    assert.equal(card.origin, manage.origin);
    const params = new URLSearchParams(manage.hash.split('?')[1]);
    const cardParams = new URLSearchParams(card.hash.split('?')[1]);
    assert.equal(params.get('houseGuid'), cardParams.get('guid'));
    assert.equal(params.get('orgRootGuid'), '6b6af071-029f-4c0f-9ad0-067997fb129c');
    assert.match(params.get('fiasHouseCode'), /^[\da-f-]{36}$/);
    assert.ok(!ids.has(params.get('houseGuid')), 'Each address has its own house card');
    ids.add(params.get('houseGuid'));
    assert.ok([...doc.querySelectorAll('a')].some(a => a.href === g.managementUrl));
    assert.ok([...doc.querySelectorAll('a')].some(a => a.href === g.houseUrl));
    assert.ok([...doc.querySelectorAll('a')].some(a => a.href === `${g.managementUrl}&index=7`));
  }
  assert.doesNotMatch(html, /Документы публикуются|Все документы · 0/);
});

test('address search supports prefilled links, exact house numbers, no results and reset', () => {
  const dom = new JSDOM(html), doc = dom.window.document;
  initGisSearch(doc, '?street=Солнечная&num=8');
  const visible = () => [...doc.querySelectorAll('.gis-house')].filter(r => !r.hidden);
  assert.equal(visible().length, 1);
  assert.equal(visible()[0].dataset.num, '8');
  const input = doc.getElementById('gis-search');
  const search = value => { input.value = value; input.dispatchEvent(new dom.window.Event('input')); };
  search('ул. Новосёлов');
  assert.ok(visible().length > 0);
  search('несуществующая улица 999');
  assert.equal(visible().length, 0);
  assert.equal(doc.getElementById('gis-empty').hidden, false);
  search('');
  assert.equal(visible().length, houses.length);
  assert.equal(doc.getElementById('gis-empty').hidden, true);
  assert.ok([...doc.querySelectorAll('.gis-street')].every(g => !g.hidden && !g.open));
});
