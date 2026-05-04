---
description: Forbidden AI-tells in Ukrainian text. Apply when writing or reviewing posts — catches signature AI phrasings before they ship.
---

# Anti-Slop — Ukrainian

Based on Wikipedia's "Signs of AI writing" guide (WikiProject AI Cleanup) and
[blader/humanizer](https://github.com/blader/humanizer), adapted for Ukrainian
Telegram news posts. The core insight: LLMs output the most statistically likely
text for the widest range of cases — which reads as puffy, sanitized, soulless.
Your job is to strip those signatures.

## Banned phrases — cut without replacement
- "Варто зазначити", "Слід відзначити", "Важливо розуміти", "Не можна не згадати"
- "Як відомо", "Очевидно що", "Безумовно", "Звичайно ж"
- "Як ніколи раніше", "У сучасному світі", "В умовах сьогодення"
- "Це свідчить про", "Дане питання", "На сьогоднішній день", "З огляду на це"
- "Не лише… а й", "Не тільки… але й"
- "Це важливо", "Варто підкреслити", "Особливо важливо"
- "Тим не менш", "Незважаючи на це" (unless there's a real contrast)
- "Проблема одна: …", "Річ одна: …", "Нюанс один: …" — setup-punchline cliché
- "Саме так виглядає…", "Саме такий вигляд має…" — recap-фраза після сценки
- "одне з найгарячіших …-захоплень/трендів/явищ" — хайпове означення

## Significance / legacy puffery — hard ban
LLMs inflate importance by framing arbitrary facts as historic turning points.
Cut these entirely — don't replace:
- "знаменує поворотний момент", "знакова подія", "віха в історії"
- "відбиває ширший тренд", "частина ширшого руху", "в контексті глобальної тенденції"
- "свідчення тривалого впливу", "невід'ємна частина", "глибоко вкорінений"
- "закладає основи для…", "формує ландшафт…", "визначає майбутнє…"
- "ключова роль", "центральне місце", "вирішальне значення"

State the fact only. If the significance isn't self-evident from the fact,
it probably isn't significant.

## Banned openers — cinematographic hooks
Never start a post with an imagined scene or "picture this" framing.
- ❌ "Уявіть: …", "Уявіть собі …", "Картина така: …", "Ось сцена: …"
- ❌ "Ви заходите в… і бачите…"
- ✅ Start with the concrete news fact (хто, що, коли).

## Banned openers — signposting / announcements
Don't announce what you're about to do. Just do it.
- ❌ "Розберімось…", "Погляньмо…", "Ось що потрібно знати…"
- ❌ "Без зайвих слів…", "Коротко про головне:"
- ✅ First sentence = first fact.

## Banned closers — moral / generalizing wrap-ups
The last sentence MUST be a concrete fact, not a worldview comment.
- ❌ "у світі, де X, Y — не головне"
- ❌ "у часи, коли …", "в епоху, що …"
- ❌ "коли/якщо X формує Y, то Z"
- ❌ "майбутнє виглядає яскравим", "попереду цікаві часи"
- ❌ Будь-яке речення, що робить узагальнення про «світ», «час», «епоху».

## Banned metaphors / clichés
- "нова валюта X", "нове золото X", "нова нафта X" — monetary-metaphor cliché
- "всі хочуть свою долю / свій шматок"
- "гарячий тренд", "гаряче захоплення", "на хвилі"
- "захоплююча подорож", "нова ера X", "світанок X", "золота доба X"
- Парні прикметники-оксиморони: "натхненно й туманно", "яскраво й обережно",
  "сміливо й обачно" — AI-style rhythmic pairing.

## Persuasive authority tropes — banned
LLMs use these to pretend they're cutting through noise to some deeper truth.
- ❌ "По суті…", "У своїй основі…", "Насправді ж…"
- ❌ "Справжнє питання…", "Глибша проблема…", "Суть справи в тому, що…"
- ❌ "Що дійсно важливо…", "Фундаментально…"
- ✅ State the point directly, no preamble.

## Copula avoidance — use "є" / "це" / "має"
LLMs substitute elaborate constructions for simple verbs of being.
- ❌ "виступає як", "слугує…", "являє собою…", "стоїть як символ…"
- ❌ "може похвалитися…", "пропонує…" (коли означає "має")
- ✅ "є", "це", "має", "складається з"

## Superficial -ing analyses / дієприслівникові хвости
Banned dangling participles that add fake depth at sentence end:
- ❌ "підкреслюючи…", "відображаючи…", "символізуючи…"
- ❌ "сприяючи…", "забезпечуючи…", "формуючи…"
- ❌ "показуючи, як…", "демонструючи…"
Also already-banned calques: "працюючий" → "який працює" (see grammar-ua).

## Elegant variation — don't cycle synonyms
AI substitutes synonyms on every mention to avoid "repetition":
- ❌ "компанія → корпорація → виробник → гігант → бренд" (того самого суб'єкта)
- ❌ "герой → протагоніст → центральний персонаж → головна дійова особа"
- ✅ Repeat the same noun or use pronouns. Repetition is fine.

## False ranges — banned
"Від X до Y" only works when X and Y are on a real continuum.
- ❌ "від Big Bang до космічної павутини, від народження зірок до темної матерії"
- ❌ "від індивідуальних розробників до міжнародних корпорацій"
- ✅ List specific items without the "від…до" frame.

## Vague attributions / weasel words — banned
- ❌ "експерти вважають", "спостерігачі зазначають", "галузеві звіти", "низка джерел"
- ✅ Name the specific source (person, outlet, study, date).
- If the source doesn't name an expert — omit the opinion entirely.

## Excessive hedging — cut
- ❌ "потенційно може", "ймовірно, мабуть", "деякою мірою можливо"
- ✅ Pick one modality or state the claim directly.

## Banned structures
- Binary contrasts: "Не X. А Y." / "Справа не в X. Справа в Y." → just say Y.
- Negative listing: "Не X. Не Y. Z." → just say Z.
- Tailing negation fragments: "…, без вгадування." / "…, без зайвих рухів." — rewrite as a real clause.
- Dramatic fragments stacked together: three short punchy sentences in a row → merge or cut.
- Three-item lists: use one or two. Three is an AI rhythm signature.
- Rhetorical questions answered immediately: cut both — keep only the answer.

## No redundant pop-culture gloss
Do not explain brand/character references the reader already knows.
- ❌ "Росомаха з коміксів Marvel", "Гаррі Поттер з книг Роулінг"
- ✅ просто "Росомаха", "Гаррі Поттер" (the name is enough).

## False agency — name the actor
- Bad: "технологія змінює ринок", "дані свідчать", "ситуація вимагає", "питання залишається"
- Fix: хто саме змінює / читає дані / вимагає / не вирішив.

## Passive voice — find the subject
- Bad: "було оголошено", "рішення було прийнято", "компанія була змушена"
- Fix: хто оголосив / хто прийняв / хто змусив.

## Format bans
- No em-dashes (—) except in the headline separator. Use commas or periods.
- No adverbs: дуже, досить, надзвичайно, вкрай, особливо, значно, суттєво (unless from source).
- No mechanical boldface for key terms — **bold** only for the headline.
- No curly quotes (“ ”) — only straight (" ").
- No emoji unless the channel skill explicitly allows.
- No paragraph that ends with a one-liner "mic drop" every time — vary endings.

## Chatbot artifacts — strip if present
These leak from model instructions. Delete on sight:
- "Звісно!", "Чудове питання!", "Сподіваюся, це допоможе!"
- "Ось огляд…", "Нижче наведено…", "Якщо потрібно, можу розгорнути…"
- "На момент останнього оновлення…", "Наскільки мені відомо…"

## Hard ban: AI-style closing sentences
The LAST sentence MUST be a concrete fact from the source. It MUST NOT be a summary, implication,
trend observation, or moral.

Delete and re-end the post if you catch any of these closing patterns:
- "Це змінює…", "Це показує…", "Це свідчить про…", "Це відбиває…"
- "Зміни відбивають глобальний тренд…", "AI продовжує трансформувати…"
- "Обіцянка не здійснилась.", "Маркетинг не збігається з реальністю."
- Any sentence beginning with "Це", "Такі", "Подібні", "Тенденція" that comments on the topic rather
  than states a fact.
- Abstract wrap-ups using nouns: "зміна", "тренд", "епоха", "ера", "еволюція".

If your draft ends that way — DELETE the last sentence entirely. Do NOT replace it. Let the post
end on the preceding concrete-fact sentence (price, date, name, quote, number).

## Final self-audit
Before returning the post, ask yourself: **"What makes this obviously AI-generated?"**
If you can name even one tell — a puffy significance line, a cinematographic opener, a moral
closer, a three-item list, a "по суті…" — rewrite that specific sentence. Repeat until clean.
