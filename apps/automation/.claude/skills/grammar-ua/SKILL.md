---
description: Ukrainian grammar and orthography rules for proofreading posts. Apply only in grammar-review contexts, not during initial writing.
---

# Ukrainian Grammar — Proofread Checklist

## Common errors to fix
- Кличний відмінок in direct address (leave untouched in headlines/reports)
- Активні дієприкметники (-уч-/-юч-): "працюючий" → "який працює"
- Калькування з російської:
  - "приймати участь" → "брати участь"
  - "на протязі" → "протягом"
  - "слідуючий" → "наступний"
- Зайве "являється": "він являється директором" → "він директор"
- Англіцизми з неправильною відмінковою формою (e.g. wrong ending on English proper nouns)

## Вид дієслова (aspect) — critical
Ukrainian distinguishes completed (доконаний) vs repeated/multiple (недоконаний/кратний) action.
A one-time completed action MUST use the matching verb.
- "постріляти" = to shoot multiple rounds / multiple targets (кратний вид).
  Wrong for a single killing: ❌ "постріляли з пневматичної гвинтівки" (one victim, one shot).
  Correct: ✅ "застрелили з пневматичної гвинтівки".
- "побити" (completed) vs "бити" (process) — "побили двох чоловіків" (one event), "били годинами" (process).
- "вбити" / "застрелити" / "зарізати" for single completed killings.
- "розстріляти" only for execution-style multi-shot killing.

Rule: if the source text describes ONE completed action against ONE target, pick the доконаний
verb that names that exact action — never the multiplicative form.

## Узгодження (agreement)
- Підмет-присудок: "Суддя вказав" (not "Судді вказав" — it's nominative singular).
- Іменник-прикметник по роду/числу/відмінку.

## Відмінки (cases) — watch объект після perfective verbs
- "отримав кулю" (accusative) not "отримав куля" (nominative leaked from source).
- "застрелив хлопця" not "застрелив хлопець".
- Always check the direct object ending after transitive verbs.

## Proper nouns — never translate
Company names, product names, person names, platform names, game titles, studio names — stay in
original language.
- Good: "Apple випустила iOS 18"
- Bad: "Еппл випустила"

## Allowed scripts
Only **Cyrillic** (Ukrainian body text) and **Latin** (proper nouns, acronyms, URLs) characters
are allowed. Strip or translate anything else:
- Chinese / Japanese / Korean: ❌ "软件інженерія" → ✅ "програмна інженерія"
- Arabic / Hebrew / other scripts: ❌ leave-in → ✅ transliterate or use English equivalent
- Pinyin / romaji / other transliterations: keep as-is (they're Latin)
- Emoji: allowed ONLY if the channel skill explicitly permits (most don't)

If you find a non-Latin, non-Cyrillic token, replace it with the correct Ukrainian (or leave the
proper noun in Latin/English). Never ship a post with leaked foreign-script fragments.

## Numbers and units
- "15%" not "15 %"
- "$8 млн" / "8 млрд грн"
- "12 березня 2026" (omit year if current)

## What NOT to change
- Facts, numbers, prices, dates, URLs
- Telegram HTML tags: `<b>`, `<i>`, `<a href="...">`, `<code>`
- Post structure and line breaks
- Post length — if anything, shorten. Never exceed 900 characters.
