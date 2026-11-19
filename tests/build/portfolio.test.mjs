import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { otherManagedHouses } from '../../src/lib/public-safety.js';

const read = path => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const data = name => JSON.parse(read(`src/data/${name}.json`));
const key = h => `${h.street}|${h.num}`;

test('hero, about, map legend and active map data use the same portfolio', () => {
  const houses = data('houses').filter(h => !h.archived);
  const addresses = new Set(houses.map(key));
  assert.equal(addresses.size, houses.length, 'No duplicate active houses');
  const mapped = data('houses_geo').filter(h => !h.archived && addresses.has(key(h)));
  assert.equal(mapped.length, houses.length, 'Every active house has one map record');
  assert.equal(new Set(mapped.map(key)).size, houses.length);
  for (const h of mapped) {
    assert.ok(Number.isFinite(h.lat) && h.lat >= 55.9 && h.lat <= 56.4, key(h));
    assert.ok(Number.isFinite(h.lon) && h.lon >= 93.1 && h.lon <= 93.6, key(h));
    assert.ok(Number.isFinite(h.area) && Number.isInteger(h.flats), key(h));
  }
  const others = otherManagedHouses(data('houses'), data('competitors'));
  assert.ok(others.every(h => !addresses.has(key(h))), 'No own house also shown as another company');
  const home = new JSDOM(read('dist/index.html')).window.document;
  assert.match(home.querySelector('.hero__sub').textContent, new RegExp(`Обслуживаем\\s+${houses.length}\\s`));
  assert.match(home.querySelector('.legend--ours').textContent, new RegExp(`\\(${houses.length}\\)`));
  const about = new JSDOM(read('dist/about/index.html')).window.document;
  const facts = [...about.querySelectorAll('.fact strong')].map(e => e.textContent.replace(/\s/g, ''));
  assert.deepEqual(facts.slice(0, 3), [String(houses.length), `${(Math.round(mapped.reduce((n,h) => n+h.area, 0)*100)/100).toLocaleString('ru-RU').replace(/\s/g, '')}м²`, String(mapped.reduce((n,h) => n+h.flats, 0))]);
  assert.equal(about.querySelector('time').dateTime, data('mingkh_sync').checkedAt);
  assert.equal(home.querySelector('.map-note time').dateTime, data('mingkh_sync').checkedAt);
});

test('home disclosure banner leads to the house picker without obsolete categories', () => {
  const doc = new JSDOM(read('dist/index.html')).window.document;
  const banner = doc.getElementById('disclosure');
  assert.match(banner.textContent, /Документы и отчёты — в ГИС ЖКХ/);
  assert.equal(banner.querySelectorAll('a').length, 1);
  assert.equal(banner.querySelector('a').getAttribute('href'), '/disclosure#gis-houses-title');
  assert.equal(banner.querySelectorAll('.disc-card').length, 0);
});
