# Английский с Марией

Главная страница опубликована через GitHub Pages из корня ветки `main`. Кабинет, расписание и запись работают на Cloudflare Workers. GitHub Pages открывает эти разделы на адресе Worker. Собственный домен не нужен.

## Локальная проверка

Из корня репозитория:

```sh
cd _worker
npm ci
npm test
npm run db:local
npm run dev
```

Откройте http://127.0.0.1:8787.

## Первый запуск на Cloudflare

1. Авторизуйтесь командой `npx wrangler login` из папки `_worker`.
2. Создайте D1 командой `npx wrangler d1 create mklending-schedule`. Укажите её идентификатор в привязке `DB` в `wrangler.jsonc`.
3. Примените схему командой `npx wrangler d1 execute mklending-schedule --remote --file=schema.sql`.
4. Выполните `npx wrangler deploy` и укажите полученный HTTPS-адрес Worker в `serviceOrigin` файла `pages-entry.js` в корне репозитория.
5. Добавьте серверный секрет `ADMIN_KEY` длиной от 32 символов, чтобы заполнять расписание через `/admin.html`. Время занятий показывается по Иркутску.

### Telegram

Укажите публичный адрес бота без @ в `TELEGRAM_BOT_USERNAME` в `wrangler.jsonc`. Кнопка открывает чат, где посетитель может отправить `/start`.

Для отправки заявок с сайта задайте секреты `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` через Cloudflare. Используйте новый токен, если прежний публиковался в истории Git. Секреты не включаются в репозиторий. После настройки проверьте переход в бота и доставку тестовой заявки.
