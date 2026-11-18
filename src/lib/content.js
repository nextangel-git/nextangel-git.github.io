// Слой данных: локальные JSON-файлы (src/data/). Правятся через свою админку
// (/admin → GitHub API) или вручную. Никаких внешних CMS.
import { newsTimestamp } from './public-safety.js';
import housesLocal from '../data/houses.json';
import docsLocal from '../data/documents.json';
import newsLocal from '../data/news.json';
import servicesLocal from '../data/services.json';
import shutdownsLocal from '../data/shutdowns.json';

export async function getHouses() {
  return housesLocal.filter((h) => !h.archived); // архив (ушли из управления) на сайте не показываем
}

export async function getDocuments() {
  return docsLocal;
}

export async function getNews() {
  // стабильный slug: id старой новости из URL, иначе id записи
  return newsLocal.map((n) => ({
    ...n,
    slug: n.slug || (n.url && (n.url.match(/news\/(\d+)\.html/) || [])[1]) || String(n.id),
  })).sort((a, b) => newsTimestamp(b.date) - newsTimestamp(a.date));
}

export async function getServices() {
  return servicesLocal;
}

// Даты проверяются также в браузере: статический HTML живёт дольше сборки.
export async function getShutdowns() {
  return shutdownsLocal.filter((s) => s.active !== false);
}
