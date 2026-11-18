// GitHub-бэкенд статичной админки ЖКС: чтение/запись src/data/*.json и public/documents/*
// через GitHub API. Токен (PAT) живёт только в памяти страницы; между сессиями —
// в localStorage в зашифрованном виде (AES-GCM, ключ из пароля) — см. admin.astro.
const OWNER = 'nextangel-git';
const REPO = 'nextangel-git.github.io';
const BRANCH = 'main';
const API = 'https://api.github.com';

let TOKEN = '';
export function setToken(t) { TOKEN = t; }
export function getToken() { return TOKEN; }

async function gh(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    cache: 'no-store',
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('Токен отклонён — сбросьте привязку и задайте токен заново');
  if (res.status === 409 || res.status === 422) throw new Error('Данные изменились в GitHub. Обновите страницу и повторите правку; чужие изменения не перезаписаны.');
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.message || `GitHub: HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// GET содержимое файла: { data, sha }
export async function readDataFile(file, ref = BRANCH) {
  if (!/^[a-z_]+\.json$/.test(file)) throw new Error('Некорректный файл данных');
  const j = await gh(`/repos/${OWNER}/${REPO}/contents/src/data/${file}?ref=${encodeURIComponent(ref)}`);
  const text = decodeURIComponent(escape(atob(j.content.replace(/\n/g, ''))));
  return { data: JSON.parse(text), sha: j.sha };
}

// PUT: один текстовый файл (простые сохранения)
export async function writeDataFile(file, data, sha, message) {
  if (!/^[a-z_]+\.json$/.test(file) || !sha) throw new Error('Нужна исходная версия файла');
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 1) + '\n')));
  await gh(`/repos/${OWNER}/${REPO}/contents/src/data/${file}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content, sha, branch: BRANCH }),
  });
}

// Мульти-файловый атомарный коммит через Git Data API.
// files: [{ path, text } | { path, base64 }] — подходит и для бинарных (PDF до ~100 МБ)
export async function commitFiles(files, message) {
  const ref = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const headSha = ref.object.sha;
  // Check the exact snapshot this commit will descend from, not a moving branch.
  for (const f of files) {
    if (!/^(src\/data\/[a-z_]+\.json|public\/documents\/[a-z0-9][a-z0-9.-]*)$/.test(f.path))
      throw new Error('Недопустимый путь файла');
    if (f.path.startsWith('src/data/')) {
      if (!f.expectedSha) throw new Error('Нужна исходная версия файла данных');
      const current = await readDataFile(f.path.slice('src/data/'.length), headSha);
      if (current.sha !== f.expectedSha) throw new Error('Данные изменились в GitHub. Обновите страницу и повторите правку; чужие изменения не перезаписаны.');
    }
  }
  const parent = await gh(`/repos/${OWNER}/${REPO}/git/commits/${headSha}`);
  const tree = [];
  for (const f of files) {
    const body = f.base64
      ? { content: f.base64, encoding: 'base64' }
      : { content: f.text, encoding: 'utf-8' };
    const blob = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, { method: 'POST', body: JSON.stringify(body) });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST', body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
  });
  const commit = await gh(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
  });
  await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }),
  });
}

// проверка токена: читаем репозиторий
export async function checkToken() {
  const repo = await gh(`/repos/${OWNER}/${REPO}`);
  if (!repo.permissions?.push) throw new Error('У токена нет права записи в репозиторий сайта');
  return true;
}
