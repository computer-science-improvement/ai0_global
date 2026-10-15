---
name: grammar-ua
description: Ukrainian grammar and orthography rules for proofreading posts — cases, aspect, calques, apostrophe ʼ, «» quotes, decimal separator, broken characters and mixed scripts. Apply in grammar-review contexts.
applies_to: [executor, reviewer, composer]
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
Company names, product names, platform names, game titles, studio names — stay in original language.
Person names follow the resource style (`uk_translit` or `original`, see `proper-nouns-terms`).
Abbreviations stay Latin: API, CLI, not «АПІ», «КЛІ» (`glossary_violation`).
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
- Decimal separator: one per post, as the resource style says (`numbers.decimal`); default is the comma — «1,05 трлн», «$1,24». A post with both «1,05» and «0.10» gets `decimal_mixed`. Versions and model names keep their dots (iOS 18.1, Gemini 2.5).
- Units for a beginner or general audience (style `units: words`): «3 млрд параметрів», «270 млн», not «3B», «270M». Model names stay as they are (Gemma 3 27B).

## Typography (the normaliser fixes it before render — write it right anyway)
- Apostrophe between Cyrillic letters is ʼ (U+02BC): «зʼявився», «пʼять», «обʼєм». One form in the whole post — never «з'явились» and «зʼявиться» side by side.
- Quotes in Ukrainian text are «ялинки»; nested — „лапки“. Straight " only in code, URLs and Latin text.
- One space between words; no double spaces.
- The normaliser never touches URLs, code, hashtags or Latin text.

## Broken characters
- The replacement character U+FFFD (a diamond with a question mark), control characters, zero-width characters inside a word, mojibake like «Ð¿Ñ€Ð¸» — lint error `text_replacement_char`. Retype the word from the source; never publish it.
- One word, one script: a Latin letter inside a Cyrillic word («Меркoff», «#aiновини») is `mixed_script_word`. Write Murkoff or Меркофф. A Latin name with a hyphenated Ukrainian ending («iPhone-ом») is allowed.

## What NOT to change
- Facts, numbers, prices, dates, URLs
- Telegram HTML tags: `<b>`, `<i>`, `<a href="...">`, `<code>`
- Post structure and line breaks
- Post length — if anything, shorten. Never exceed 900 characters.
