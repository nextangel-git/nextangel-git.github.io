// Public client key. Validation and the secret key belong exclusively to PHP.
export const SMARTCAPTCHA_SITEKEY = 'ysc1_c1z811srDG3allSQnw0xpIy1ubAve2lTWfeKJrLe29c108b2';
const loaders = new WeakMap();
let sequence = 0;

function loadCaptcha(window) {
  if (window.smartCaptcha) return Promise.resolve(window.smartCaptcha);
  if (loaders.has(window)) return loaders.get(window);
  const promise = new Promise((resolve, reject) => {
    const script = window.document.createElement('script');
    const callback = `jksCaptchaLoaded${++sequence}`;
    const finish = (error) => {
      window.clearTimeout(timer);
      script.onerror = null;
      delete window[callback];
      if (error) { script.remove(); reject(error); }
      else resolve(window.smartCaptcha);
    };
    const timer = window.setTimeout(() => finish(new Error('timeout')), 15000);
    window[callback] = () => finish(window.smartCaptcha ? null : new Error('unavailable'));
    script.src = `https://smartcaptcha.cloud.yandex.ru/captcha.js?render=onload&onload=${callback}`;
    script.async = true;
    script.onerror = () => finish(new Error('network'));
    window.document.head.append(script);
  }).catch(error => { loaders.delete(window); throw error; });
  loaders.set(window, promise);
  return promise;
}

export function mountSmartCaptcha(container, onChange = () => {}) {
  const window = container.ownerDocument.defaultView;
  container.classList.add('jks-captcha');
  container.innerHTML = '<div class="jks-captcha-widget"></div><p class="jks-captcha-status" role="status" aria-live="polite"></p><button class="jks-captcha-retry" type="button" hidden>Повторить загрузку проверки</button>';
  const widget = container.querySelector('.jks-captcha-widget');
  const status = container.querySelector('.jks-captcha-status');
  const retry = container.querySelector('.jks-captcha-retry');
  let token = '', api, id, destroyed = false, loading = false;
  let unsubscribe = [];
  const setToken = value => { token = typeof value === 'string' ? value : ''; onChange(token); };
  const fail = () => {
    if (destroyed) return;
    setToken('');
    status.textContent = 'Проверка «Я не робот» недоступна. Проверьте соединение и повторите загрузку.';
    retry.hidden = false;
  };
  const disposeWidget = () => {
    unsubscribe.forEach(fn => fn()); unsubscribe = [];
    if (id !== undefined) { api.destroy(id); id = undefined; }
  };
  async function start() {
    if (destroyed || loading) return;
    loading = true; retry.hidden = true; setToken('');
    status.textContent = 'Загружаем проверку «Я не робот»…';
    try {
      disposeWidget();
      api = await loadCaptcha(window);
      if (destroyed) return;
      status.textContent = 'Подтвердите, что вы не робот.';
      id = api.render(widget, {
        sitekey: SMARTCAPTCHA_SITEKEY, hl: 'ru', invisible: false,
        callback: value => {
          if (destroyed) return;
          setToken(value);
          status.textContent = token ? 'Проверка пройдена.' : 'Подтвердите, что вы не робот.';
          retry.hidden = true;
        },
      });
      unsubscribe = [
        api.subscribe(id, 'token-expired', () => {
          if (destroyed) return;
          setToken(''); status.textContent = 'Срок проверки истёк. Пройдите её снова.';
        }),
        api.subscribe(id, 'network-error', fail),
        api.subscribe(id, 'javascript-error', fail),
      ];
    } catch { fail(); }
    finally { loading = false; }
  }
  retry.addEventListener('click', start);
  start();
  return {
    get token() { return token; },
    reset() {
      if (destroyed) return;
      setToken('');
      if (id !== undefined) {
        try { api.reset(id); status.textContent = 'Пройдите проверку «Я не робот» снова.'; }
        catch { fail(); }
      }
    },
    destroy() { destroyed = true; disposeWidget(); token = ''; },
  };
}
