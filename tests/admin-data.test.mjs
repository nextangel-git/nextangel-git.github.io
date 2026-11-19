import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecord, validateKey, validateUpload, recordAt, updateHouseGeo } from '../src/lib/admin-data.js';

test('editing preserves IDs, slugs, archive flags and unknown metadata while clearing optional fields', () => {
  const old = { id: 10, slug: 'old', archived: true, src: 'GIS', title: 'Old', desc: 'Remove' };
  const next = mergeRecord(old, { title: 'New', desc: '' }, [{ key: 'title', label: 'Title', required: true }, { key: 'desc' }]);
  assert.deepEqual(next, { id: 10, slug: 'old', archived: true, src: 'GIS', title: 'New' });
  assert.equal(old.desc, 'Remove');
});
test('required fields, invalid prices and dangerous URLs are rejected', () => {
  assert.throws(() => mergeRecord({}, { body: '' }, [{ key: 'body', required: true }]));
  for (const value of [NaN, -1, Infinity]) assert.throws(() => mergeRecord({}, { price: value }, [{ key: 'price', type: 'number' }]));
  assert.throws(() => mergeRecord({}, { url: 'javascript:alert(1)' }, [{ key: 'url', type: 'url' }]));
  assert.equal(mergeRecord({}, { price: 0 }, [{ key: 'price', type: 'number' }]).price, 0);
});
test('article keys cannot replace existing articles or prototype properties', () => {
  for (const key of ['__proto__', 'constructor', 'a/b', 'a"b', '']) assert.throws(() => validateKey(key, {}, true));
  assert.throws(() => validateKey('existing', { existing: {} }, true));
  assert.doesNotThrow(() => validateKey('existing', { existing: {} }, false));
});
test('uploads reject active documents, empty files and over-limit files', () => {
  for (const name of ['evil.html', 'evil.svg', 'evil.js', 'noextension', 'evil.php.pdf', 'evil.PHP8.jpg', 'evil.phtml.png', 'evil.phar.docx', 'evil.inc.xls']) assert.throws(() => validateUpload({ name, size: 12 }));
  assert.throws(() => validateUpload({ name: 'a.pdf', size: 0 }));
  assert.throws(() => validateUpload({ name: 'a.pdf', size: 25 * 1024 * 1024 + 1 }));
  assert.doesNotThrow(() => validateUpload({ name: 'Отчёт.PDF', size: 42 }));
});
test('invalid indices never resolve to the first, last or inherited record', () => {
  for (const idx of ['-1', '', 'abc', '1.5']) assert.equal(recordAt([{}], {}, idx), undefined);
  assert.equal(recordAt({}, { dict: true }, 'constructor'), undefined);
  assert.equal(recordAt([{ items: [{ id: 1 }] }], { nested: true }, '0.0').id, 1);
});
test('house address edits and transfers preserve known coordinates without inventing locations', () => {
  const old = { street: 'Old', num: '1', lat: 55, lon: 92, year: 1980 };
  const edited = updateHouseGeo(old, { street: 'Corrected', num: '1' }, [old]);
  assert.deepEqual(edited, [{ ...old, street: 'Corrected' }]);
  assert.equal(old.street, 'Old');
  const known = { street: 'Known', num: '2', lat: 55, lon: 92 };
  assert.deepEqual(updateHouseGeo(null, known, [], [known]), [known]);
  assert.deepEqual(updateHouseGeo(null, { street: 'Unknown', num: '3' }, [], []), []);
});
