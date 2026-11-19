export function initGisSearch(doc, query = '') {
  const input = doc.getElementById('gis-search');
  if (!input) return;
  const rows = [...doc.querySelectorAll('.gis-house')];
  const groups = [...doc.querySelectorAll('.gis-street')];
  const normalize = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]+/gi, ' ').trim();
  const params = new URLSearchParams(query);
  input.value = [params.get('street'), params.get('num')].filter(Boolean).join(', ');
  const render = () => {
    const terms = normalize(input.value).split(' ').filter(t => t && !['ул', 'улица', 'д', 'дом', 'г', 'сосновоборск'].includes(t));
    let count = 0;
    for (const row of rows) {
      const address = normalize(`${row.dataset.street} ${row.dataset.num}`).split(' ');
      row.hidden = !terms.every(t => address.some(a => /^\d/.test(t) ? a === t : a.includes(t)));
      if (!row.hidden) count++;
    }
    for (const group of groups) {
      group.hidden = ![...group.querySelectorAll('.gis-house')].some(row => !row.hidden);
      group.open = terms.length > 0 && !group.hidden;
    }
    doc.getElementById('gis-count').textContent = terms.length ? `Найдено адресов: ${count}` : `Адресов в перечне: ${count}. Выберите улицу или начните вводить адрес.`;
    doc.getElementById('gis-empty').hidden = count > 0;
  };
  doc.getElementById('gis-search-controls').hidden = false;
  input.addEventListener('input', render);
  render();
}
