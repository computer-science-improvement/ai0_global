# Управління часом публікацій

Розклад кожної стратегії задається полем `"schedule"` у `channels.json` у форматі cron. Зміна розкладу — редагування JSON і перезапуск сервісу.

---

## Структура cron-виразу

```
┌─────── хвилина (0–59)
│ ┌───── година (0–23)
│ │ ┌─── день місяця (1–31)
│ │ │ ┌─ місяць (1–12)
│ │ │ │ ┌ день тижня (0–7, де 0 і 7 = неділя)
│ │ │ │ │
* * * * *
```

---

## Приклади розкладів

| Вираз | Коли запускається |
|-------|-------------------|
| `*/5 * * * *` | Кожні 5 хвилин |
| `0 * * * *` | Щогодини (00 хвилин) |
| `0 9 * * *` | Щодня о 09:00 |
| `0 8,12,18 * * *` | Тричі на день: 08:00, 12:00, 18:00 |
| `0 8-22/2 * * *` | Кожні 2 год з 08:00 до 22:00 |
| `0 9-21/3 * * *` | Кожні 3 год з 09:00 до 21:00 |
| `0 10 * * 1-5` | Щопн-пт о 10:00 |
| `0 20 * * 5` | Щоп'ятниці о 20:00 |
| `30 8 * * *` | Щодня о 08:30 |

---

## Значення за замовчуванням

Якщо `"schedule"` не вказаний — використовується:
```
0 8-23/2 * * *
```
тобто кожні **2 години** у проміжку **08:00 – 23:00**.

---

## Затримка між постами (`postDelayMinutes`)

Необов'язкове поле. Якщо кілька стратегій підключені до одного каналу і спрацьовують одночасно, затримка дозволяє уникнути flood-обмежень Telegram.

За замовчуванням: `30` хвилин.

```json
{
  "id": "ua-news:dev-ua",
  "type": "ua-news",
  "channelId": "@my_channel",
  "schedule": "0 9-21/3 * * *",
  "postDelayMinutes": 60
}
```

---

## Приклад: один канал, кілька стратегій

```json
{
  "strategies": [
    {
      "id": "on-this-day:morning",
      "type": "on-this-day",
      "channelId": "@news_channel",
      "schedule": "0 9 * * *"
    },
    {
      "id": "ai0-news:main",
      "type": "ai0-news",
      "channelId": "@news_channel",
      "schedule": "0 10-22/2 * * *"
    },
    {
      "id": "quotes:evening",
      "type": "quotes",
      "channelId": "@news_channel",
      "schedule": "0 21 * * *"
    }
  ]
}
```

Результат: о 09:00 — факт з історії, з 10:00 по 22:00 кожні 2 год — новина, о 21:00 — цитата.

---

## Приклад: одна стратегія, кілька RSS-джерел

Для `ua-news` кожне джерело — окрема інстанція з власним `id`:

```json
{
  "strategies": [
    {
      "id": "ua-news:dev-ua",
      "type": "ua-news",
      "channelId": "@ua_tech",
      "schedule": "0 9-21/4 * * *",
      "params": { "feedUrl": "https://dev.ua/rss", "sourceName": "dev.ua", "tags": ["dev_ua"] }
    },
    {
      "id": "ua-news:speka",
      "type": "ua-news",
      "channelId": "@ua_tech",
      "schedule": "0 11-21/4 * * *",
      "params": { "feedUrl": "https://speka.ua/rss", "sourceName": "speka.ua", "tags": ["speka_ua"] }
    }
  ]
}
```

Джерела розведені у часі (+2 год зсув) — публікації чергуються.

---

## Як змінити розклад

1. Відкрити `apps/automation/config/channels.json` (prod) або `channels-dev.json` (dev)
2. Знайти потрібну стратегію за `"id"`
3. Змінити поле `"schedule"`
4. Перезапустити сервіс:

```bash
# Локально
pnpm run dev:automation

# Production (Docker)
docker compose --profile prod restart automation
```

---

## Зупинка окремої стратегії

Щоб тимчасово вимкнути стратегію без видалення — видаліть або закоментуйте її з масиву `"strategies"` у JSON. JSON не підтримує коментарі, тому найпростіше — видалити об'єкт і зберегти резервну копію.

---

## Ручний запуск (dev)

У development-середовищі є HTTP-ендпоінт для ручного тригера:

```
GET /trigger/:strategyType
```

Наприклад:
```bash
curl http://localhost:3001/trigger/ai0-news
curl http://localhost:3001/trigger/ua-news
curl http://localhost:3001/trigger/daily-photo
```

Доступний лише при `NODE_ENV=development`.
