# Развёртывание проекта «ЖКС»

## Архитектура (с 08.11.2026)

Всё внутри GitHub — никаких локальных серверов и внешних CMS:

```
Сотрудник УК → /admin на сайте → GitHub API (коммит в репо)
                                    ↓ push
                              GitHub Actions: npm ci → build
                                    ↓
                              GitHub Pages (сайт)
```

- **Репозиторий (архив сайта):** https://github.com/nextangel-git/nextangel-git.github.io
- **Сайт:** https://nextangel-git.github.io
- Зеркало на surge.sh (демо): https://jks-sosnovoborsk.surge.sh

## Локальная разработка

Требования: Node.js 24+.

```bash
git clone https://github.com/nextangel-git/nextangel-git.github.io.git
cd nextangel-git.github.io
npm install
npm run dev        # http://localhost:4321
npm run build      # прод-сборка → dist/
```

## Деплой

Автоматически: `git push` в `main` → GitHub Actions (`/.github/workflows/deploy.yml`) собирает и публикует на Pages за ~1–2 минуты. Руками ничего деплоить не нужно.

## Админка (для сотрудников УК)

Классическая серверная админка `admin/` (Express): **логин/пароль (bcrypt) + TOTP 2FA (Google Authenticator / Яндекс Ключ) + SVG-капча**, сессии 8 часов, защита от перебора (5 неудач → пауза 10 минут).

Разделы: новости, документы, дома, отключения, услуги, FAQ, полезные статьи, заявки, посты VK (последние два — чтение/авто).

### Запуск локально

Двойной клик по `ЗАПУСК-АДМИНКИ.bat` в корне репозитория или:

```bash
cd admin
npm install   # один раз
npm start     # http://127.0.0.1:4777
```

### Пользователи (через консоль сервера)

```bash
node server.mjs --add-user ivan "Иван (УК)" 'Пароль123!'   # создать
node server.mjs --passwd ivan 'НовыйПароль'                 # сменить пароль
node server.mjs --reset-totp ivan                           # сбросить 2FA
```

При первом входе пользователь сканирует QR-код и включает 2FA сам. Файл `admin/users.json` (хэши + секреты 2FA) в git **не коммитится** (в .gitignore).

### Как это работает

Каждое сохранение = запись `src/data/*.json` → `git commit` + `git push` с сервера (PAT живёт в credential manager git на сервере, в браузер не отдаётся) → GitHub Actions → сайт обновляется через 2–3 минуты.

### Резервная админка на GitHub Pages

`https://nextangel-git.github.io/admin` — статичная версия через GitHub API (вход токеном PAT). Оставлена как запасной вариант, когда серверная админка недоступна.

### Перенос админки на сервер (для постоянной работы УК)

Серверной админке нужен постоянно работающий Node.js: VPS (Timeweb/Selectel, от ~250 ₽/мес) или любой компьютер в офисе УК. На сервере: клон репо + `admin/npm install` + `npm start` (под pm2/systemd), наружу смотрит только HTTPS-порт админки (admin.jks.ooo). Сайт при этом остаётся на бесплатном GitHub Pages.

## Данные

Источник истины — `src/data/*.json` в репозитории: houses, documents, news, services, shutdowns, faq, useful, vk_posts (авто), competitors, houses_geo.

## Ежемесячная сверка домов

`python migration/mingkh_sync.py` (из папки `migration/` в проекте jks.ooo) — собирает все дома Сосновоборска с dom.mingkh.ru, при изменениях обновляет данные. Прогон — по необходимости (перед показом УК / после смен портфеля).

## Форма заявки

1. Основной путь: FormSubmit → почта `jkssosnovoborsk@fldubai.com` (проектная). При переходе на uk@jks.ooo: поменять `FORM_TARGET` в `src/pages/request.astro`, на первую отправку придёт письмо-активация — кликнуть.
2. Фолбэк: mailto на uk@jks.ooo (работает всегда).
3. Антиспам: ханипот + time-trap (встроено).

## Боевой запуск на домене jks.ooo

1. В репо: Settings → Pages → Custom domain → `jks.ooo` (или www).
2. У регистратора домена: A-записи на 185.199.108.153–111 (GitHub Pages) или CNAME на `nextangel-git.github.io`.
3. **Карта редиректов** со старых URL — `migration/redirects-map.md` (обязательно: ссылки из квитанций и ГИС ЖКХ).
4. HTTPS включится автоматически (Let's Encrypt от GitHub).

## Проверка после развёртывания

- [ ] Главная открывается, поиск дома → карточка
- [ ] Карта домов: 104 синих + конкуренты цветные, легенда со счётчиками
- [ ] /disclosure — фильтры, PDF открываются
- [ ] /news/<id> — статья с файлами
- [ ] /request — форма отправляет (или mailto-фолбэк)
- [ ] /admin — вход по PAT, правка новости → через 2–3 мин на сайте
- [ ] Версия для слабовидящих включается и запоминается
- [ ] Телефоны кликабельны (tel:) на мобильном
