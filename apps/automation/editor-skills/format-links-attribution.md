---
name: format-links-attribution
description: Посилання й атрибуція — коли source обовʼязковий, як підписувати, inline-лінки в тексті, library_ref для бібліотеки.
applies_to: [executor, reviewer, composer]
---
# Посилання та атрибуція

## Коли що
| origin | Що обовʼязково |
|---|---|
| `external` (RSS, сайт, web_fetch) | `source: {url, label}` — першоджерело, не агрегатор |
| `library` (query_data) | `library_ref` = `ref` рядка (`data://…`, або `library_ref` із застарілого search_library); `source` — якщо в записі є url |
| `original` (власний текст, порада, опитування) | нічого |

Стиль показу задає картка (`link_style`) — рендерер зробить сам:
- `inline` → рядок «→ NASA» після тексту;
- `footer` → «Джерело: NASA» перед хештегами;
- `button` → кнопка під постом.

## label
Коротка назва видання/організації: «NASA», «Укрправда», «The Verge». Не «тут», не «посилання», не повний URL.

## Посилання всередині тексту
Формат `[текст](https://url)` — тільки https/http. Не більше 2 inline-лінків на пост. Не ховай рекламні/реферальні посилання.

## Заборонено
- Вигадувати URL. Якщо джерела немає — origin не `external`.
- Ставити посилання на сторінку пошуку, на головну сайту замість статті.
- Копіювати текст джерела дослівно — переказуй своїми словами (див. `source-licensing`).

## Приклад
✅ `"origin": "external", "source": {"url": "https://www.nasa.gov/image-article/ring-nebula/", "label": "NASA"}`
❌ `"origin": "external"` без source → lint: `source_required`.
