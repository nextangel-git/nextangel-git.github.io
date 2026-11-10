# Переезд на Beget VPS — всё в одном хостинге

Итоговая схема: один VPS Beget держит **и сайт, и админку**. GitHub остаётся бесплатным бэкапом кода и данных (пуш при каждом сохранении).

```
посетитель → https://jks.ooo        → nginx → статика (dist/)
сотрудник  → https://admin.jks.ooo  → nginx → админка (Node, 127.0.0.1:4777)
                                              ↓ сохранение
                                  src/data/*.json → astro build → dist/
                                              → git push → GitHub (бэкап)
```

## 1. Купить VPS

- beget.com → VPS → тариф **1 vCPU / 2 ГБ / 15 ГБ NVMe (~660 ₽/мес)**. Минимальный (1 ГБ) тоже заведётся, но сборке сайта может не хватить памяти — тогда добавить swap (ниже).
- ОС: **Ubuntu 24.04**. Оплата: карта, СБП, для УК — счёт на безналичную оплату.
- После создания Beget выдаст IP и root-пароль (SSH).

## 2. Подготовка сервера

```bash
ssh root@<IP>
apt update && apt upgrade -y
apt install -y git nginx curl ufw

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# pm2 — держит админку запущенной после перезагрузок
npm install -g pm2

# файрвол
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable
```

## 3. Проект

```bash
mkdir -p /var/www && cd /var/www
git clone https://github.com/nextangel-git/nextangel-git.github.io.git jks
cd jks
npm install
npm run build          # первая сборка сайта → dist/
cd admin && npm install --omit=dev
```

Если `npm run build` падает по памяти (1 ГБ тариф), добавьте swap:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 4. Пользователи админки

`admin/users.json` в git не хранится — создаётся на сервере:

```bash
cd /var/www/jks/admin
node server.mjs --add-user denis "Денис" '<придумать-пароль>'
node server.mjs --add-user uk "Сотрудник УК" '<пароль-для-УК>'
```

При первом входе каждый настроит 2FA по QR-коду. Git на сервере:

```bash
git config --global user.name "jks-admin" && git config --global user.email "uk@jks.ooo"
```

Для бэкап-пушей в GitHub (GIT_PUSH=1): создать fine-grained PAT (только этот репо, Contents: RW) и один раз выполнить `git push`, введя токен — git credential сохранит.

## 5. Запуск админки

```bash
cd /var/www/jks
# ВНИМАНИЕ: в deploy/ecosystem.config.cjs заменить SESSION_SECRET на длинную случайную строку!
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup   # автозапуск при перезагрузке
```

## 6. nginx + HTTPS

```bash
cp /var/www/jks/deploy/nginx-jks.conf /etc/nginx/sites-available/jks
ln -s /etc/nginx/sites-available/jks /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

apt install -y certbot python3-certbot-nginx
certbot --nginx -d jks.ooo -d www.jks.ooo -d admin.jks.ooo
```

## 7. DNS (у регистратора jks.ooo)

| Запись | Тип | Значение |
|---|---|---|
| jks.ooo | A | IP сервера |
| www.jks.ooo | A | IP сервера |
| admin.jks.ooo | A | IP сервера |

После DNS и certbot: сайт — https://jks.ooo, админка — https://admin.jks.ooo.

## 8. Редиректы со старого сайта

Старый сайт (1С-Битрикс) отключается после переключения DNS. Карта редиректов — `migration/redirects-map.md`; правила добавляются в nginx `server {}` сайта.

## Проверка после переезда

- [ ] https://jks.ooo открывается, карта и дома на месте
- [ ] https://admin.jks.ooo → вход (пароль + капча + 2FA)
- [ ] Правка новости в админке → через 1–2 минуты видна на сайте (сборка на сервере)
- [ ] В GitHub появился коммит от jks-admin (бэкап работает)
- [ ] `pm2 status` — jks-admin online; `systemctl status nginx` — active
