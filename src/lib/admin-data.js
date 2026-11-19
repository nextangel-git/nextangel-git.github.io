// Shared validation for both administration interfaces. Never discard hidden metadata.
export function mergeRecord(previous, values, fields) {
  const result = { ...previous };
  for (const field of fields) {
    if (!Object.hasOwn(values, field.key)) continue;
    const value = values[field.key];
    if (field.required && (value == null || String(value).trim() === ''))
      throw new Error(`Заполните поле «${field.label}»`);
    if (field.type === 'number' && value != null && value !== '' && (!Number.isFinite(value) || value < 0))
      throw new Error(`Некорректное число: ${field.label}`);
    if (field.type === 'url' && value && !/^https?:\/\//i.test(value))
      throw new Error(`Нужна ссылка http:// или https://: ${field.label}`);
    if (value === '' || value === null) delete result[field.key];
    else result[field.key] = value;
  }
  return { ...result, ...Object.fromEntries(Object.entries(values).filter(([key]) => !fields.some(f => f.key === key))) };
}

export function validateKey(key, data, isNew) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key))
    throw new Error('Ключ: строчные латинские буквы, цифры и дефис');
  if (isNew && Object.hasOwn(data, key)) throw new Error('Статья с таким ключом уже существует');
}

export function validateUpload(file) {
  if (/\.(?:php[0-9]*|phtml|phar|inc|cgi|pl|py|sh|shtml)(?:\.|$)/i.test(file.name))
    throw new Error('Недопустимое составное расширение файла');
  if (!/\.(pdf|docx?|xlsx?|jpe?g|png)$/i.test(file.name))
    throw new Error('Разрешены только PDF, DOC, DOCX, XLS, XLSX, JPG и PNG');
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('Нужен непустой файл размером до 25 МБ');
}

export function recordAt(data, cfg, idx) {
  if (cfg.dict) return Object.hasOwn(data, idx) ? data[idx] : undefined;
  if (cfg.nested) {
    if (!/^\d+\.\d+$/.test(idx)) return undefined;
    const [ci, ii] = idx.split('.').map(Number);
    return data[ci]?.items?.[ii];
  }
  return /^\d+$/.test(String(idx)) ? data[Number(idx)] : undefined;
}

export function updateHouseGeo(previous, next, geo, registry = []) {
  const norm = value => String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const matches = (a, b) => norm(a.street) === norm(b.street) && norm(a.num) === norm(b.num);
  const result = structuredClone(geo);
  let entry = previous?.street ? result.find(x => matches(x, previous)) : result.find(x => matches(x, next));
  if (!entry) {
    const known = registry.find(x => matches(x, next));
    if (known) { entry = structuredClone(known); result.push(entry); }
  }
  if (entry) {
    entry.street = next.street; entry.num = next.num;
    if (next.archived) entry.archived = true; else delete entry.archived;
  }
  return result;
}
