import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { cleanEditorHtml, mountRichEditors } from '../src/lib/rich-editor.js';
import { articleHtml } from '../src/lib/article-html.js';

test('editor strips active content and unsafe URLs, keeps publication formatting', () => {
  const dom = new JSDOM();
  const html = cleanEditorHtml(dom.window.document, '<script>alert(1)</script><p onclick="bad()"><strong>Текст</strong></p><a href="javascript:alert(1)">x</a><img src="https://jks.ooo/a.png" onerror="bad()"><iframe src="/admin"></iframe><ul><li>Пункт</li></ul>');
  assert.doesNotMatch(html, /script|onclick|onerror|iframe|javascript/);
  assert.match(html, /<strong>Текст<\/strong>/);
  assert.equal(articleHtml(html).replace(/ \/>/g, '>'), html);
  assert.equal(cleanEditorHtml(dom.window.document, '<h1>Новость</h1><h6>Подпись</h6><img src="/images/photo.jpg">'), '<h1>Новость</h1><h6>Подпись</h6><img src="/images/photo.jpg">');
  dom.window.close();
});

test('unchanged article is preserved; edited HTML reaches form data; empty article rejected', () => {
  const dom = new JSDOM('<form><textarea name="body" data-rich-text="Текст статьи" required></textarea></form>');
  const { document, Event, FormData } = dom.window;
  const textarea = document.querySelector('textarea');
  const original = '<h2>Заголовок</h2>\n<p>Текст <b>жирный</b></p>';
  textarea.value = original;
  const form = document.querySelector('form'), sync = mountRichEditors(form);
  const content = document.querySelector('[contenteditable]');
  assert.equal(content.querySelector('h2').textContent, 'Заголовок');
  sync(); assert.equal(new FormData(form).get('body'), original);
  content.innerHTML = '<p>Изменено <em>курсивом</em></p>';
  content.dispatchEvent(new Event('input')); sync();
  assert.equal(new FormData(form).get('body'), content.innerHTML);
  content.innerHTML = '<p><br></p>';
  content.dispatchEvent(new Event('input'));
  assert.throws(sync, /Заполните текст/);
  assert.equal(document.activeElement, content);
  dom.window.close();
});

test('toolbar restores text selection and paste uses plain text', () => {
  const dom = new JSDOM('<form><textarea data-rich-text="Текст">&lt;p&gt;Текст&lt;/p&gt;</textarea></form>');
  const { document, Event } = dom.window;
  mountRichEditors(document.querySelector('form'));
  const content = document.querySelector('[contenteditable]');
  const range = document.createRange(); range.selectNodeContents(content.querySelector('p'));
  dom.window.getSelection().addRange(range);
  content.dispatchEvent(new Event('mouseup'));
  const commands = [];
  document.execCommand = (command, _, value) => { commands.push([command,value,dom.window.getSelection().toString()]); return true; };
  document.querySelector('[data-command=bold]').click();
  assert.deepEqual(commands[0], ['bold',null,'Текст']);
  const paste = new Event('paste', { cancelable: true });
  Object.defineProperty(paste,'clipboardData',{value:{getData: type => type === 'text/plain' ? 'Вставка' : '<script>bad()</script>'}});
  content.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true);
  assert.equal(commands[1][0], 'insertText'); assert.equal(commands[1][1], 'Вставка');
  dom.window.close();
});
