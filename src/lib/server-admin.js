// Same-origin session API. GitHub credentials stay on the server.
const ENDPOINT = '/api/admin.php';
let session = { authenticated: false, user: null, csrf: '' };

export function getSessionState() { return { ...session }; }
export function clearSession() { session = { authenticated: false, user: null, csrf: '' }; }

function updateSession(payload) {
  if (typeof payload?.authenticated === 'boolean') {
    session.authenticated = payload.authenticated;
    session.user = payload.authenticated ? (payload.user ?? null) : null;
  }
  if (typeof payload?.csrf === 'string') session.csrf = payload.csrf;
  return getSessionState();
}

async function api(action, { method = 'GET', params = {}, body } = {}) {
  const query = new URLSearchParams({ action, ...params });
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    if (!session.csrf) await refreshSession();
    if (!session.csrf) throw new Error('Не удалось подготовить защищённый вход. Обновите страницу.');
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = session.csrf;
  }
  const response = await fetch(`${ENDPOINT}?${query}`, {
    method, credentials: 'same-origin', cache: 'no-store', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) {
      session.authenticated = false;
      session.user = null;
    }
    if (response.status === 403) session.csrf = '';
    const conflict = 'Данные изменились. Обновите страницу и повторите правку; чужие изменения не перезаписаны.';
    const error = new Error(response.status === 409 ? conflict : (payload?.message || (response.status === 401 ? 'Сессия завершена. Войдите снова.' : `Сервер админки недоступен (HTTP ${response.status}). Попробуйте позже.`)));
    error.status = response.status;
    error.code = payload?.error;
    throw error;
  }
  if (!payload || typeof payload !== 'object') throw new Error('Сервер вернул некорректный ответ. Откройте админку на jks.ooo.');
  updateSession(payload);
  return payload;
}

export async function refreshSession() {
  return updateSession(await api('session'));
}

export async function login(username, password, captchaToken) {
  await refreshSession();
  const result = await api('login', { method: 'POST', body: { username, password, captchaToken } });
  if (!session.authenticated) throw new Error('Вход не подтверждён сервером. Попробуйте снова.');
  return result;
}

export async function logout() {
  await api('logout', { method: 'POST', body: {} });
  clearSession();
}

export function changePassword(currentPassword, newPassword) {
  return api('password', { method: 'POST', body: { currentPassword, newPassword } });
}

export function readDataFile(file, ref) {
  if (!/^[a-z_]+\.json$/.test(file)) throw new Error('Некорректный файл данных');
  return api('read', { params: { file, ...(ref ? { ref } : {}) } });
}

export function writeDataFile(file, data, sha, message) {
  if (!/^[a-z_]+\.json$/.test(file) || !sha) throw new Error('Нужна исходная версия файла');
  return commitFiles([{ path: `src/data/${file}`, text: JSON.stringify(data, null, 1) + '\n', expectedSha: sha }], message);
}

export function commitFiles(files, message) {
  if (!Array.isArray(files) || !files.length) throw new Error('Нет файлов для сохранения');
  for (const file of files) {
    if (!/^(src\/data\/[a-z_]+\.json|public\/documents\/[a-z0-9][a-z0-9.-]*)$/.test(file.path)) throw new Error('Недопустимый путь файла');
    if (file.path.startsWith('src/data/') && !file.expectedSha) throw new Error('Нужна исходная версия файла данных');
    if ((typeof file.text === 'string') === (typeof file.base64 === 'string')) throw new Error('Нужно одно содержимое файла: text или base64');
  }
  return api('commit', { method: 'POST', body: { files, message } });
}
