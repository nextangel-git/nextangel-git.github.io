# Развёртывание проекта «ЖКС»

Требования: **Node.js 24+** и npm. Python не нужен (только для скриптов миграции в `migration/`).

## 1. Сайт (jks-site)

```bash
cd jks-site
npm install
npm run dev        # разработка → http://localhost:4321
npm run build      # прод-сборка → dist/
npm run preview    # посмотреть сборку локально
```

Сайт полностью работает и без CMS (фолбэк на `src/data/*.json`).

## 2. CMS (jks-cms) — нужна, чтобы сотрудники УК правили контент

```bash
cd jks-cms
npm install
npm run develop    # http://localhost:1337/admin
```

- При первом запуске создайте учётку администратора (придумаете пароль сами).
- Данные подливаются автоматически из `src/seed/` при пустой базе (файл `database/data.db`).
- Публичный API — только чтение: `/api/houses`, `/api/documents`, `/api/news-items`, `/api/service-categories`.

### Важно про Node 24

В `jks-cms/package.json` зафиксировано `better-sqlite3: ^13.0.3` — на Node 24 ставится готовый бинарник.
Не понижайте до 12.x: он требует Visual Studio Build Tools для компиляции.

## 3. Связка сайт + CMS

Сайт при сборке читает CMS по адресу из переменной окружения:

```bash
# Windows (cmd):        set STRAPI_URL=http://localhost:1337
# PowerShell:           $env:STRAPI_URL="http://localhost:1337"
# bash:                 export STRAPI_URL=http://localhost:1337
cd jks-site && npm run build
```

Без переменной берётся `http://localhost:1337`. Если CMS не отвечает (таймаут 3 сек) — сборка идёт на локальных JSON.

**Рабочий цикл обновления контента:**
1. Сотрудник правит контент в админке Strapi (1337/admin).
2. Пересборка сайта: `npm run build` в jks-site.
3. Деплой `dist/` (см. ниже).
(Позже: автоматизация через webhook Strapi → rebuild → deploy.)

### Автопересборка по webhook (рекомендуется)

1. Скопируйте `jks-site/.env.example` в `jks-site/.env`, задайте `REBUILD_SECRET` (и `SURGE_*` для автодеплоя).
2. Держите запущенным рядом с CMS: `node scripts/rebuild-server.mjs` (порт 4777).
3. В админке Strapi: **Settings → Webhooks → Create** → URL `http://localhost:4777/rebuild`, заголовок `x-rebuild-secret: <REBUILD_SECRET>`, события Entry create/update/delete.
4. Любая правка контента в админке → сайт пересобирается (и улетает на surge) сам. Дебаунс 2 сек: серия правок = одна сборка.

### Мини-админка на русском (для сотрудников УК)

Strapi 5 поставляется только с английским интерфейсом — поэтому для УК есть своя админка.

1. Запущен офисный сервер: `node scripts/rebuild-server.mjs` (порт 4777, рядом с CMS).
2. Вход: `http://localhost:4777/admin`, пароль из `jks-site/.env` (`ADMIN_PASSWORD`, по умолчанию `jks-admin` — сменить!).
3. Три формы: **Новость**, **Отключение**, **Документ**. После публикации сайт пересобирается и обновляется сам (~1 минута).
4. Полная админка Strapi (`localhost:1337/admin`) остаётся для служебных задач (дома, тарифы, права).
5. Запись идёт через API-токен Strapi (`STRAPI_WRITE_TOKEN` в `jks-cms/.env`; создаётся: Settings → API tokens).

## 4. Деплой на surge.sh (текущий демо-хостинг)

Аккаунт: `jkssosnovoborsk@fldubai.com` / `JksSosn2026Secure`
(почта mail.tm — читается через https://api.mail.tm или любым mail.tm-клиентом; email подтверждён, сайт не будет приостановлен)

```bash
# получить токен (или взять сохранённый у того, кто деплоил)
curl -X POST https://surge.surge.sh/token -u "jkssosnovoborsk@fldubai.com:JksSosn2026Secure"

cd jks-site
npm run build
set SURGE_LOGIN=jkssosnovoborsk@fldubai.com
set SURGE_TOKEN=<токен из ответа выше>
npx surge dist jks-sosnovoborsk.surge.sh
```

Проверка: https://jks-sosnovoborsk.surge.sh

## 5. Боевой запуск (когда УК скажет «да»)

1. Хостинг: любой статический (Cloudflare Pages / reg.ru / Timeweb) или VPS + nginx. БД не нужна.
2. CMS: VPS (1 ГБ RAM хватит) или оставить в офисе УК; сборка сайта по webhook.
3. Домен: перенести jks.ooo на новый сайт.
4. **Карта редиректов** со старых URL обязательна (ссылки из квитанций и ГИС ЖКХ).
5. HTTPS — через хостинг (Let's Encrypt).

## 6. Форма заявки — как работает отправка

1. Основной путь: FormSubmit (formsubmit.co) на проектную почту `jkssosnovoborsk@fldubai.com`. Уже активирован для `jks-sosnovoborsk.surge.sh`.
2. Фолбэк: если шлюз недоступен из сети посетителя — кнопка «Открыть готовое письмо» (mailto на `uk@jks.ooo`).
3. CMS-запас: в Strapi есть тип «Заявка» с разрешением create для публичного API (запись без чтения). На боевом сервере форму стоит переключить на него: POST `STRAPI_URL/api/requests`.

**При смене домена** (jks.ooo): FormSubmit пришлёт новое письмо-активацию на первую отправку с нового домена — кликнуть один раз. Адрес назначения меняется в `src/pages/request.astro`, константа `FORM_TARGET`.

## Проверка после развёртывания

- [ ] Главная открывается, поиск дома находит адрес и ведёт в карточку
- [ ] /disclosure — фильтры и поиск по документам, PDF открываются
- [ ] /news/<id> — статья с приложенными файлами
- [ ] /request — форма проходит валидацию
- [ ] Версия для слабовидящих включается и запоминается
- [ ] Телефоны кликабельны (tel:) на мобильном
