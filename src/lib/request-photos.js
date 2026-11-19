export const PHOTO_LIMITS = { count: 5, perFile: 5_000_000, total: 10_000_000 };
const types = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const photoSize = bytes => bytes < 1000 ? `${bytes} Б` : bytes < 1_000_000
  ? `${(bytes / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ`
  : `${(bytes / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} МБ`;

export function validatePhotos(files) {
  if (files.length > PHOTO_LIMITS.count) return 'Можно добавить не более 5 фотографий.';
  for (const file of files) {
    if (!/\.(jpe?g|png|webp)$/i.test(file.name) || (file.type && !types.has(file.type))) return 'Выберите фотографии JPG, PNG или WebP.';
    if (!file.size || file.size > PHOTO_LIMITS.perFile) return 'Каждая фотография должна быть не больше 5 МБ и не должна быть пустой.';
  }
  if (files.reduce((size, file) => size + file.size, 0) > PHOTO_LIMITS.total) return 'Общий размер фотографий не должен превышать 10 МБ.';
  return '';
}

export function mountRequestPhotos(root) {
  const doc = root.ownerDocument, win = doc.defaultView;
  const input = root.querySelector('input[type=file]');
  const list = root.querySelector('[data-photo-list]');
  const status = root.querySelector('[data-photo-status]');
  const error = root.querySelector('[data-photo-error]');
  let entries = [], locked = false;
  const render = () => {
    list.replaceChildren();
    for (const entry of entries) {
      const item = doc.createElement('li'), preview = doc.createElement('img');
      preview.src = entry.url; preview.alt = '';
      const info = doc.createElement('span');
      info.textContent = `${entry.file.name} · ${photoSize(entry.file.size)}`;
      const remove = doc.createElement('button');
      remove.type = 'button'; remove.className = 'btn btn--ghost'; remove.textContent = 'Удалить';
      remove.setAttribute('aria-label', `Удалить фото: ${entry.file.name}`); remove.disabled = locked;
      remove.addEventListener('click', () => {
        if (locked) return;
        win.URL.revokeObjectURL(entry.url); entries = entries.filter(e => e !== entry);
        error.textContent = ''; input.setCustomValidity(''); render(); input.focus();
      });
      item.append(preview, info, remove); list.append(item);
    }
    const size = entries.reduce((n, e) => n + e.file.size, 0);
    status.textContent = entries.length ? `Выбрано фото: ${entries.length} из 5 · ${photoSize(size)} (лимит 10 МБ)` : 'Фото не выбраны.';
  };
  input.addEventListener('change', () => {
    if (locked) return;
    const additions = [...input.files].filter(f => !entries.some(e => e.file.name === f.name && e.file.size === f.size && e.file.lastModified === f.lastModified));
    const message = validatePhotos([...entries.map(e => e.file), ...additions]);
    input.value = '';
    input.setCustomValidity(message); error.textContent = message;
    if (!message) {
      entries.push(...additions.map(file => ({ file, url: win.URL.createObjectURL(file) })));
      render();
    }
  });
  root.querySelector('[data-photo-clear]').addEventListener('click', () => {
    if (locked) return;
    for (const entry of entries) win.URL.revokeObjectURL(entry.url);
    entries = []; input.value = ''; input.setCustomValidity(''); error.textContent = ''; render(); input.focus();
  });
  win.addEventListener('pagehide', event => { if (!event.persisted) for (const e of entries) win.URL.revokeObjectURL(e.url); });
  render();
  return {
    get files() { return entries.map(e => e.file); },
    lock(value) { locked = value; input.disabled = value; root.querySelectorAll('button').forEach(b => { b.disabled = value; }); },
  };
}
