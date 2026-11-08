// GitHub-бэкенд админки ЖКС: чтение/запись src/data/*.json через GitHub API.
// Аутентификация: fine-grained PAT (repo: contents read+write), хранится в localStorage браузера админа.
const OWNER = 'nextangel-git';
const REPO = 'nextangel-git.github.io';
const BRANCH = 'main';
const API = 'https://api.github.com';

export function getToken() { return localStorage.getItem('jks_gh_token') || ''; }
export function setToken(t) { localStorage.setItem('jks_gh_token', t); }
export function clearToken() { localStorage.removeItem('jks_gh_token'); }

async function gh(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) { clearToken(); throw new Error('Токен отклонён — проверьте PAT'); }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.message || `GitHub: HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// GET содержимое файла: { data, sha }
export async function readDataFile(file) {
  const j = await gh(`/repos/${OWNER}/${REPO}/contents/src/data/${file}?ref=${BRANCH}`);
  const text = decodeURIComponent(escape(atob(j.content.replace(/\n/g, ''))));
  return { data: JSON.parse(text), sha: j.sha };
}

// PUT: записать обновлённый файл
export async function writeDataFile(file, data, sha, message) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 1) + '\n')));
  await gh(`/repos/${OWNER}/${REPO}/contents/src/data/${file}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content, sha, branch: BRANCH }),
  });
}

// проверка токена: читаем репозиторий
export async function checkToken() {
  await gh(`/repos/${OWNER}/${REPO}`);
  return true;
}
