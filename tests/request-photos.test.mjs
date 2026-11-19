import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePhotos } from '../src/lib/request-photos.js';

test('photo limits accept boundaries and reject oversized, excessive, empty and non-image files', () => {
  const photo = (size=1,name='a.jpg',type='image/jpeg') => ({size,name,type});
  assert.equal(validatePhotos([]),'');
  assert.equal(validatePhotos([photo(5_000_000),photo(5_000_000)]),'');
  assert.equal(validatePhotos(Array.from({length:5},()=>photo(2_000_000))),'');
  assert.match(validatePhotos([photo(5_000_001)]),/5 МБ/);
  assert.match(validatePhotos([photo(5_000_000),photo(5_000_000),photo(1)]),/10 МБ/);
  assert.match(validatePhotos(Array.from({length:6},()=>photo())),/не более 5/);
  assert.ok(validatePhotos([photo(0)]));
  assert.ok(validatePhotos([photo(100,'file.svg','image/svg+xml')]));
  assert.ok(validatePhotos([photo(100,'file.jpg','text/plain')]));
  assert.equal(validatePhotos([photo(100,'camera.JPG','')]),'');
});
