# Структура даних у data/

Усі JSON-файли приведені до **єдиного формату** для зручної роботи та завантаження в БД.

## Єдина структура

```json
{
  "source": "назва-джерела",
  "count": 123,
  "items": [
    {
      "title": "Коротка назва / заголовок",
      "description": "Основний текст (опис, промпт, інструкція)",
      "link": "https://... або null",
      "source": "URL сторінки-джерела або null",
      "category": "категорія або null",
      "extra": {}
    }
  ]
}
```

### Поля верхнього рівня

| Поле       | Тип   | Опис                                      |
|------------|-------|-------------------------------------------|
| `source`   | string| Ідентифікатор набору (ім'я файлу без .json) |
| `count`    | number| Кількість елементів у `items`             |
| `categories` | array | Опційно: список категорій (mcpservers)   |
| `items`    | array | Масив записів                             |

### Поля кожного елемента в `items`

| Поле         | Тип   | Опис |
|--------------|-------|------|
| `title`      | string| Коротка назва (case, title, name)        |
| `description`| string| Основний текст (prompt, description)      |
| `link`       | string \| null | Посилання на ресурс (ChatGPT, сторінка MCP тощо) |
| `source`     | string \| null | URL сторінки, з якої взято запис         |
| `category`   | string \| null | Категорія (для mcpservers)               |
| `extra`      | object| Додаткові поля, специфічні для джерела   |

### Відповідність файлів

| Файл               | title      | description | link | source | category | extra                |
|--------------------|------------|-------------|------|--------|----------|----------------------|
| academy-openai.json| `case`     | `prompt`    | ✓    | ✓      | —        | `{ case, prompt }`   |
| prompts-md.json    | `title`    | `description`| —   | —      | —        | `{ typescript }`     |
| mcpservers.json    | `name`     | `description`| ✓   | —      | ✓        | —                    |

Після нормалізації всі файли мають однакові ключі `title`, `description`, `link`, `source`, `category`, `extra`; оригінальні поля зберігаються в `extra` де потрібно.

### Як застосувати

З кореня проєкту:
```bash
npm run normalize:data
```
Скрипт: `src/tools/normalize-data.js`. Можна запускати повторно — підтримується вже нормалізований формат. Якщо спочатку потрібні свіжі дані, запусти парсери (`npm run parse:academy`, `npm run parse:md`, `npm run parse:mcpservers`), потім `npm run normalize:data`.
