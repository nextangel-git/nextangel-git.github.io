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

Адрес: **https://nextangel-git.github.io/admin** (по-русски, прямо на сайте).

Разделы: новости, документы, дома, отключения, услуги, FAQ, полезные статьи, заявки, посты VK (последние два — чтение/авто).

### Первый вход (один раз)

1. GitHub → профиль → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. Repository access: только `nextangel-git/nextangel-git.github.io`
3. Permissions: **Contents: Read and write**
4. Скопировать токен (`github_pat_…`) и вставить в форму входа на `/admin`
5. Токен хранится только в браузере сотрудника (localStorage), никуда не отправляется кроме api.github.com

### Как это работает

Каждое сохранение в админке = коммит в репозиторий (файлы `src/data/*.json`) → push запускает GitHub Actions → сайт пересобирается и обновляется на Pages через 2–3 минуты.

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
