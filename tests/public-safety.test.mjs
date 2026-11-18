import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, safeHref, shutdownExpiresAt, isShutdownVisible, newsTimestamp, russianPlural, otherManagedHouses, confirmedServicePrice } from '../src/lib/public-safety.js';
import { articleHtml } from '../src/lib/article-html.js';

test('data cannot escape HTML text or quoted attributes', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml("'"), '&#39;');
});

test('document links reject script protocols, controls and protocol-relative URLs', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', '//evil.test', '/\\evil.test', 'java\nscript:alert(1)', 'https://user:pass@example.org']) assert.equal(safeHref(url), '#');
  for (const url of ['/documents/report.pdf', 'https://example.org/report.pdf', '#documents']) assert.equal(safeHref(url), url);
});

test('shutdowns expire at the next midnight in Krasnoyarsk, without another build', () => {
  const before = Date.parse('2026-11-19T23:59:59+07:00');
  const after = Date.parse('2026-11-20T00:00:00+07:00');
  const record = { until: '2026-11-19' };
  assert.equal(isShutdownVisible(record, before), true);
  assert.equal(isShutdownVisible(record, after), false);
  assert.equal(shutdownExpiresAt(record.until), after);
  assert.equal(isShutdownVisible({ active: false }, before), false);
  assert.equal(isShutdownVisible({}, before), true);
  assert.equal(isShutdownVisible({ until: '2026-02-30' }, before), false);
  assert.equal(isShutdownVisible({ until: 'bad date' }, before), false);
});

test('news date sorting and count labels handle real calendar values', () => {
  assert.ok(newsTimestamp('01.01.2027') > newsTimestamp('31.12.2026'));
  assert.equal(newsTimestamp('31.02.2026'), 0);
  const forms = ['дом', 'дома', 'домов'];
  assert.deepEqual([1, 2, 5, 11, 21, 104].map(n => russianPlural(n, forms)), ['дом', 'дома', 'домов', 'домов', 'дом', 'дома']);
});

test('article sanitizer preserves formatting and strips active content', () => {
  const html = articleHtml('<h2>Заголовок</h2><p>Текст <strong>жирный</strong></p><script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">ссылка</a><iframe src="https://example.org"></iframe>');
  assert.match(html, /<h2>Заголовок<\/h2>/);
  assert.match(html, /<strong>жирный<\/strong>/);
  assert.doesNotMatch(html, /script|onerror|javascript:|iframe/);
});

test('a transferred house no longer belongs to a competitor on the map or legend', () => {
  const houses = [{ street: '  Берёзовая ', num: 1 }, { street: 'Мира', num: '2', archived: true }];
  const competitors = [{ street: 'березовая', num: '1' }, { street: 'Мира', num: '2' }, { street: 'Мира', num: '3', archived: true }];
  assert.deepEqual(otherManagedHouses(houses, competitors), [competitors[1]]);
});

test('only explicitly confirmed, valid UK service prices are public', () => {
  for (const item of [{ price: 500 }, { price: 500, priceConfirmed: false }, { price: -1, priceConfirmed: true }, { price: '500', priceConfirmed: true }]) assert.equal(confirmedServicePrice(item), null);
  assert.equal(confirmedServicePrice({ price: 500, priceConfirmed: true }), 500);
  assert.equal(confirmedServicePrice({ price: 0, priceConfirmed: true }), 0);
});
