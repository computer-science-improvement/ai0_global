#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Scrape recipes from foodcourt.com.ua using Claude CLI + Playwright MCP
#
# Usage:
#   ./scripts/scrape-recipes.sh
#   MAX_RECIPES=10 ./scripts/scrape-recipes.sh   # limit for testing
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_FILE="$ROOT_DIR/apps/pipeline/additional-data/datasets/recipes/recipes.json"
MAX_RECIPES="${MAX_RECIPES:-50}"

echo "Launching Claude agent to scrape recipes from foodcourt.com.ua"
echo "   Output: $OUTPUT_FILE"
echo "   Max recipes: $MAX_RECIPES"
echo ""

PROMPT="Ти агент-скрапер. Твоя задача:

## Крок 0: Встановлення браузера
Спочатку виконай browser_install щоб встановити браузер для Playwright.

## Крок 1: Дослідження сайту
Відкрий https://foodcourt.com.ua/ через Playwright MCP (browser_navigate).
Зроби скріншот (browser_take_screenshot) щоб зрозуміти структуру сайту.
Знайди розділи з рецептами, категорії, пагінацію.
Якщо Playwright не працює — використай WebFetch як запасний варіант.

## Крок 2: Збір рецептів
Пройдись по категоріях або сторінках рецептів.
Для кожного рецепту збери:
- title — назва страви
- url — повне посилання на рецепт
- description — короткий опис страви (1-2 речення)
- ingredients — інгредієнти у текстовому форматі (перелік через кому або списком)
- instructions — кроки приготування
- image_url — URL головного зображення
- category — категорія (перші, другі страви, десерти, салати, тощо)
- tags — масив тегів (наприклад [\"м'ясо\", \"духовка\", \"український\"])

Зайди НА КОЖНУ сторінку рецепту щоб зібрати повну інформацію (інгредієнти, кроки).
Зібрати потрібно МАКСИМУМ ${MAX_RECIPES} рецептів.

## Крок 3: Генерація постів для Telegram
Для КОЖНОГО рецепту згенеруй поле post_text — готовий пост для Telegram каналу.

### ПРАВИЛА для post_text:
1. Мова: українська
2. НЕ використовуй АІ-маркери: \"Варто зазначити\", \"Слід відзначити\", \"Безумовно\", \"Як відомо\"
3. НЕ використовуй рекламну мову: \"найкращий\", \"неперевершений\", \"ідеальний\", \"революційний\"
4. НЕ використовуй фразу \"Вам сподобається\", \"Побалуйте себе\", \"Ідеально підійде\"
5. Тон: як друг розповідає рецепт який спробував. Інформативно і тепло, без зайвого
6. Називай актора: не \"було приготовано\" а \"готуємо\"
7. Використовуй активний стан: не \"подається з\" а \"подавай з\"
8. Конкретні числа: \"печемо 25 хвилин при 180°C\" а не \"деякий час у духовці\"
9. HTML форматування для Telegram:
   - <b>назва страви</b> жирним
   - список інгредієнтів через новий рядок
   - кроки приготування коротко
10. ДОВЖИНА: намагайся вмістити у 1024 символи (це ліміт caption для фото в Telegram).
    Якщо рецепт складний і не вміщається — максимум 4048 символів.
11. В кінці додай теги: #рецепт #категорія

### Приклад формату post_text:
<b>Борщ класичний</b>

Буряк, капуста, картопля, морква, цибуля, часник, томатна паста, яловичина.

Варимо бульйон з яловичини 1.5 години. Буряк тремо на великій тертці, тушкуємо з томатною пастою 10 хвилин. Додаємо картоплю у бульйон, через 10 хвилин — капусту, ще через 5 — зажарку з моркви та цибулі. В кінці додаємо буряк і часник. Даємо настоятися 30 хвилин.

Подавай зі сметаною та пампушками з часником.

#рецепт #перші_страви #борщ #українська_кухня

## Крок 4: Збереження
Збережи результат у файл: ${OUTPUT_FILE}

Формат JSON:
{
  \"source\": \"foodcourt.com.ua\",
  \"scraped_at\": \"ISO date string\",
  \"recipes\": [
    {
      \"title\": \"...\",
      \"url\": \"...\",
      \"description\": \"...\",
      \"ingredients\": \"...\",
      \"instructions\": \"...\",
      \"image_url\": \"...\",
      \"category\": \"...\",
      \"tags\": [\"...\"],
      \"post_text\": \"...\"
    }
  ]
}

ВАЖЛИВО:
- Не вигадуй рецепти, бери тільки з сайту
- Кожен пост має бути унікальним і готовим до публікації
- Якщо сайт блокує або не відповідає — повідом про це
- Зберігай прогрес: якщо зібрав частину — збережи що є"

claude -p "$PROMPT" \
  --allowedTools "mcp__plugin_playwright_playwright__browser_install,mcp__plugin_playwright_playwright__browser_navigate,mcp__plugin_playwright_playwright__browser_snapshot,mcp__plugin_playwright_playwright__browser_click,mcp__plugin_playwright_playwright__browser_take_screenshot,mcp__plugin_playwright_playwright__browser_evaluate,mcp__plugin_playwright_playwright__browser_close,mcp__plugin_playwright_playwright__browser_wait_for,WebFetch,Write,Read,Bash" \
  --model sonnet \
  --max-turns 80

echo ""
echo "Scraping complete. Checking output..."

if [ -f "$OUTPUT_FILE" ]; then
  COUNT=$(node -e "const d=JSON.parse(require('fs').readFileSync('$OUTPUT_FILE','utf-8')); console.log((d.recipes||d).length)")
  echo "Found $COUNT recipes in $OUTPUT_FILE"
else
  echo "Output file not found. The agent may have encountered issues."
  exit 1
fi
