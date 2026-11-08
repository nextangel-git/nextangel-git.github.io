// Слой данных: локальные JSON-файлы (src/data/). Правятся через свою админку
// (scripts/rebuild-server.mjs → /admin) или вручную. Никаких внешних CMS.
import housesLocal from '../data/houses.json';
import docsLocal from '../data/documents.json';
import newsLocal from '../data/news.json';
import servicesLocal from '../data/services.json';
import shutdownsLocal from '../data/shutdowns.json';

export async function getHouses() {
  return housesLocal;
}

export async function getDocuments() {
  return docsLocal;
}

export async function getNews() {
  // стабильный slug: id старой новости из URL, иначе id записи
  return newsLocal.map((n) => ({
    ...n,
    slug: n.slug || (n.url && (n.url.match(/news\/(\d+)\.html/) || [])[1]) || String(n.id),
  }));
}

export async function getServices() {
  return servicesLocal;
}

// Отключения: активные, не истёкшие по дате
export async function getShutdowns() {
  const now = new Date();
  return shutdownsLocal.filter((s) => s.active !== false && (!s.until || new Date(s.until) >= now));
}
