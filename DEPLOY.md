# Развёртывание проекта «ЖКС»

Два состояния проекта:

| | Сейчас (временно) | Целевое (прод) |
|---|---|---|
| Сайт | GitHub Pages: https://nextangel-git.github.io | Beget VPS: https://jks.ooo |
| Админка | локально: http://127.0.0.1:4777 | Beget VPS: https://admin.jks.ooo |
| Демо-зеркало | https://jks-sosnovoborsk.surge.sh | отключается |
| Репозиторий (код + данные + бэкап) | https://github.com/nextangel-git/nextangel-git.github.io | тот же |

**Инструкция по переезду на Beget — в [DEPLOY-BEGET.md](DEPLOY-BEGET.md).** Ниже — текущее развёртывание и общие вещи.

## Локальная разработка

Требования: Node.js 22+.

```bash
git clone https://github.com/nextangel-git/nextangel-git.github.io.git
cd nextangel-git.github.io
npm install
npm run dev        # http://localhost:4321
npm run build      # прод-сборка → dist/
```

## Деплой сайта (сейчас, GitHub Pages)

Автоматически: `git push` в `main` → GitHub Actions (`/.github/workflows/deploy.yml`) собирает и публикует на Pages за ~1–2 минуты. Руками ничего деплоить не нужно.

## Админка

Классическая серверная админка `admin/` (Express): **логин/пароль (bcrypt) + TOTP 2FA (Google Authenticator / Яндекс Ключ) + SVG-капча**, сессии 8 часов, защита от перебора (5 неудач → пауза 10 минут).

Разделы: новости, документы, дома, отключения, услуги, FAQ, полезные статьи, заявки, посты VK (последние два — чтение/авто).

### Запуск локально

Двойной клик по `ЗАПУСК-АДМИНКИ.bat` в корне репозитория или:

```bash
cd admin
npm install   # один раз
npm start     # http://127.0.0.1:4777
```

### Пользователи (через консоль)

```bash
node server.mjs --add-user ivan "Иван (УК)" 'Пароль123!'   # создать (первый = админ)
node server.mjs --passwd ivan 'НовыйПароль'                 # сменить пароль
node server.mjs --reset-totp ivan                           # сбросить 2FA
```

При первом входе пользователь сканирует QR-код и включает 2FA сам. Файл `admin/users.json` (хэши + секреты 2FA) в git **не коммитится** (в .gitignore).

### Как это работает

Каждое сохранение = запись `src/data/*.json` → `git commit` + `git push` (PAT живёт в credential manager git на машине, в браузер не отдаётся) → GitHub Actions → сайт обновляется через 2–3 минуты. На VPS-режиме (`REBUILD=1`) сайт пересобирается прямо на сервере — см. DEPLOY-BEGET.md.

### Резервная админка на GitHub Pages

`https://nextangel-git.github.io/admin` — статичная версия через GitHub API (вход токеном PAT). Запасной вариант, когда серверная админка недоступна.

## Данные

Источник истины — `src/data/*.json` в репозитории: houses, documents, news, services, shutdowns, faq, useful, vk_posts (авто), competitors, houses_geo, requests.

## Ежемесячная сверка домов

`python migration/mingkh_sync.py` (из папки `migration/` в проекте jks.ooo) — собирает все дома Сосновоборска с dom.mingkh.ru, при изменениях обновляет данные. Прогон — по необходимости (перед показом УК / после смен портфеля).

## Форма заявки

1. Основной путь: FormSubmit → почта `jkssosnovoborsk@fldubai.com` (проектная). При переходе на uk@jks.ooo: поменять `FORM_TARGET` в `src/pages/request.astro`, на первую отправку придёт письмо-активация — кликнуть.
2. Фолбэк: mailto на uk@jks.ooo (работает всегда).
3. Антиспам: ханипот + time-trap (встроено).

## Проверка после развёртывания

- [ ] Главная открывается, поиск дома → карточка
- [ ] Карта домов: 104 синих + конкуренты цветные, легенда со счётчиками
- [ ] /disclosure — фильтры, PDF открываются
- [ ] /news/<id> — статья с файлами
- [ ] /request — форма отправляет (или mailto-фолбэк)
- [ ] Админка: вход (пароль + капча + 2FA), правка новости → через 2–3 мин на сайте
- [ ] Версия для слабовидящих включается и запоминается
- [ ] Телефоны кликабельны (tel:) на мобильном
