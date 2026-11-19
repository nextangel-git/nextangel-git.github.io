// Publication times use the site's timezone, independently of browser/build timezone.
export function publicationInfo(value) {
  const m = String(value || '').match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);
  if (!m) return null;
  const local = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}`;
  const check = new Date(local + ':00Z');
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0,16) !== local) return null;
  const iso = local + ':00+07:00';
  return { iso, timestamp: Date.parse(iso), label: value };
}

export function usefulEntries(data) {
  return Object.entries(data).map((entry,index) => ({entry,index,time:publicationInfo(entry[1].publishedAt)?.timestamp || 0}))
    .sort((a,b) => b.time-a.time || b.index-a.index).map(item => item.entry);
}

export function publicationNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('ru-RU', { timeZone:'Asia/Krasnoyarsk', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date()).map(p => [p.type,p.value]));
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}
