import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

test('built VK cards preserve optional dates and exact public post links', t => {
  const posts = JSON.parse(fs.readFileSync(new URL('../../src/data/vk_posts.json', import.meta.url), 'utf8')).slice(0, 4);
  const dom = new JSDOM(fs.readFileSync(new URL('../../dist/index.html', import.meta.url), 'utf8'));
  t.after(() => dom.window.close());
  const cards = [...dom.window.document.querySelectorAll('#vk .news-card')];
  assert.equal(cards.length, posts.length);
  cards.forEach((card, index) => {
    const post = posts[index];
    assert.equal(card.getAttribute('href'), post.url);
    const url = new URL(post.url);
    assert.ok(['vk.com', 'vk.ru'].includes(url.hostname));
    const identity = url.pathname.startsWith('/wall') ? url.pathname.slice(5) : url.searchParams.get('w')?.replace(/^wall/, '');
    assert.equal(identity, post.id);
    assert.match(post.id, /^-189230176_\d+$/);
    assert.equal(card.getAttribute('target'), '_blank');
    assert.ok(card.getAttribute('rel').split(/\s+/).includes('noopener'));
    assert.equal(card.querySelector('time')?.textContent ?? null, post.date || null);
    assert.doesNotMatch(card.textContent, /Invalid Date|undefined|\bnull\b/);
  });
});
