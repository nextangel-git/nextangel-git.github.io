// Deliberately small editor: content stays on our origin, saved as existing HTML.
const tags = new Set('p div br h1 h2 h3 h4 h5 h6 strong b em i u s strike del ul ol li blockquote a img table thead tbody tfoot tr th td hr span sub sup pre code caption'.split(' '));
const discard = new Set('script style iframe object embed svg math form input button textarea select template'.split(' '));
export function cleanEditorHtml(document, html) {
  const template = document.createElement('template');
  template.innerHTML = String(html ?? '');
  for (const node of [...template.content.querySelectorAll('*')]) {
    const tag = node.localName;
    if (discard.has(tag)) { node.remove(); continue; }
    for (const attr of [...node.attributes]) {
      const key = attr.name, value = attr.value;
      const url = (tag === 'a' && key === 'href') || (tag === 'img' && key === 'src');
      const safeUrl = url && !/[\u0000-\u0020\\]/.test(value) && (/^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value) || /^\.\.?\//.test(value) || (tag === 'a' && /^(mailto:|tel:|#)/i.test(value)));
      const safeText = (tag === 'a' && key === 'title') || (tag === 'img' && key === 'alt');
      const safeNumber = ['td', 'th', 'img'].includes(tag) && ['colspan', 'rowspan', 'width', 'height'].includes(key) && /^\d{1,4}$/.test(value);
      if (!safeUrl && !safeText && !safeNumber) node.removeAttribute(key);
    }
    if (!tags.has(tag)) node.replaceWith(...node.childNodes);
  }
  return template.innerHTML;
}

export function mountRichEditors(form) {
  const document = form.ownerDocument, win = document.defaultView;
  const editors = [];
  for (const textarea of form.querySelectorAll('textarea[data-rich-text]')) {
    const box = document.createElement('div'); box.className = 'rich-editor';
    box.innerHTML = `<div class="rich-toolbar" role="group" aria-label="Форматирование текста">
      <select aria-label="Стиль абзаца"><option value="p">Обычный текст</option><option value="h2">Заголовок</option><option value="h3">Подзаголовок</option><option value="blockquote">Цитата</option></select>
      ${[['bold','Жирный','Ж'],['italic','Курсив','К'],['underline','Подчёркнутый','Ч'],['insertUnorderedList','Маркированный список','• Список'],['insertOrderedList','Нумерованный список','1. Список'],['createLink','Добавить ссылку','Ссылка'],['unlink','Убрать ссылку','Без ссылки'],['removeFormat','Очистить оформление','Очистить'],['undo','Отменить действие','↶'],['redo','Повторить действие','↷']].map(([command,label,text])=>`<button type="button" data-command="${command}" title="${label}" aria-label="${label}">${text}</button>`).join('')}
      </div><div class="rich-content" contenteditable="true" role="textbox" aria-multiline="true"></div><p class="rich-hint">Выделите текст и выберите инструмент. Ctrl+Z — отменить действие. Вставка из буфера — без чужого оформления.</p>`;
    const content = box.querySelector('.rich-content');
    content.setAttribute('aria-label', textarea.dataset.richText);
    content.setAttribute('aria-required', String(textarea.required));
    const required = textarea.required;
    content.innerHTML = cleanEditorHtml(document, textarea.value);
    textarea.required = false; textarea.hidden = true; textarea.after(box);
    let dirty = false, range = null;
    const remember = () => {
      const selection = win.getSelection();
      if (selection.rangeCount && content.contains(selection.getRangeAt(0).commonAncestorContainer)) range = selection.getRangeAt(0).cloneRange();
    };
    const restore = () => {
      content.focus();
      if (range && content.contains(range.commonAncestorContainer)) {
        const selection = win.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
    };
    content.addEventListener('input', () => { dirty = true; content.removeAttribute('aria-invalid'); remember(); });
    content.addEventListener('keyup', remember); content.addEventListener('mouseup', remember); content.addEventListener('blur', remember);
    const execute = (command, value = null) => {
      restore(); document.execCommand(command, false, value); dirty = true; remember();
    };
    box.querySelector('.rich-toolbar').addEventListener('mousedown', event => {
      remember(); if (event.target.closest('button')) event.preventDefault();
    });
    box.querySelector('.rich-toolbar').addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button) return;
      const command = button.dataset.command;
      if (command === 'createLink') {
        const url = win.prompt('Адрес ссылки (https://…, mailto:… или tel:…)');
        if (url === null) return;
        if (!/^(https?:\/\/\S+|mailto:\S+|tel:\S+)$/i.test(url.trim())) { win.alert('Введите полный адрес ссылки, например https://jks.ooo'); return; }
        restore();
        if (win.getSelection().isCollapsed) { win.alert('Сначала выделите текст, который станет ссылкой.'); return; }
        execute(command, url.trim());
      } else execute(command);
    });
    box.querySelector('select').addEventListener('change', event => execute('formatBlock', event.target.value));
    content.addEventListener('paste', event => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') || '';
      execute('insertText', text);
    });
    // Do not allow dropped HTML/files to bypass paste sanitization.
    content.addEventListener('drop', event => event.preventDefault());
    editors.push(() => {
      if (required && !content.textContent.replace(/\u00a0/g, ' ').trim() && !content.querySelector('img[src]')) {
        content.setAttribute('aria-invalid', 'true'); content.focus();
        throw new Error('Заполните текст статьи');
      }
      // Preserve untouched existing content byte-for-byte.
      if (dirty) textarea.value = cleanEditorHtml(document, content.innerHTML);
    });
  }
  return () => editors.forEach(sync => sync());
}
