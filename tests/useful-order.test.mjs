import test from 'node:test';
import assert from 'node:assert/strict';
import { usefulEntries, publicationInfo, publicationNow } from '../src/lib/useful-order.js';
import { COLLECTIONS } from '../src/lib/collections.mjs';
import { mergeRecord } from '../src/lib/admin-data.js';

test('articles sort by publication time, independent of keys and subsequent edits', () => {
  const articles = { newest: {publishedAt:'19.11.2026 13:47'}, old: {publishedAt:'18.11.2026 02:31'}, undated:{}, middle: {publishedAt:'19.11.2026 12:00'} };
  assert.deepEqual(usefulEntries(articles).map(([key])=>key), ['newest','middle','old','undated']);
  assert.deepEqual(Object.keys(articles), ['newest','old','undated','middle']);
  const before={title:'old',body:'text',publishedAt:'18.11.2026 02:31'};
  assert.equal(mergeRecord(before,{title:'edited',body:'changed'},COLLECTIONS.useful.fields).publishedAt,before.publishedAt);
  assert.equal(publicationInfo('19.11.2026 13:47').iso,'2026-11-19T13:47:00+07:00');
  for(const bad of ['', '31.02.2026 01:00', '19.11.2026 24:01']) assert.equal(publicationInfo(bad),null);
  assert.ok(publicationInfo(publicationNow()));
});
