// Shared by build-time templates and browser code. Never insert raw content into HTML.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function safeHref(value) {
  const url = String(value ?? '').trim();
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url)) return '#';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (url.startsWith('#')) return url;
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? url : '#';
  } catch { return '#'; }
}

// "Показывать до" includes the entire selected day in Sosnovoborsk (UTC+7).
export function shutdownExpiresAt(until) {
  if (!until) return Infinity;
  const match = String(until).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  const day = new Date(`${until}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== until) return NaN;
  return day.getTime() + 24 * 60 * 60 * 1000 - 7 * 60 * 60 * 1000;
}

export function isShutdownVisible(shutdown, now = Date.now()) {
  return shutdown.active !== false && now < shutdownExpiresAt(shutdown.until);
}

export function russianPlural(number, forms) {
  const n = Math.abs(number) % 100;
  return forms[n > 10 && n < 20 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
}

export function newsTimestamp(value) {
  const match = String(value ?? '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return 0;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? date.getTime() : 0;
}

export function addressKey(house) {
  const normalize = value => String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  return `${normalize(house.street)}|${normalize(house.num)}`;
}

export function otherManagedHouses(houses, competitors) {
  const active = new Set(houses.filter(h => !h.archived).map(addressKey));
  return competitors.filter(h => !h.archived && !active.has(addressKey(h)));
}

export function confirmedServicePrice(service) {
  return service.priceConfirmed === true && Number.isFinite(service.price) && service.price >= 0
    ? service.price : null;
}
