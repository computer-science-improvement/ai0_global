import { Skill } from './skill.interface';

/**
 * Eliminates AI-generated writing patterns.
 * Adapted from https://github.com/hardikpandya/stop-slop
 */
export const ANTI_SLOP_SKILL: Skill = {
  name: 'anti-slop',
  instructions: `
## Anti-AI Writing Rules

### Banned phrases — cut without replacement
"Варто зазначити", "Слід відзначити", "Важливо розуміти", "Не можна не згадати"
"Як відомо", "Очевидно що", "Безумовно", "Звичайно ж"
"Як ніколи раніше", "У сучасному світі", "В умовах сьогодення"
"Це свідчить про", "Дане питання", "На сьогоднішній день", "З огляду на це"
"Не лише… а й", "Не тільки… але й"
"Це важливо", "Варто підкреслити", "Особливо важливо"
"Тим не менш", "Незважаючи на це" (unless there's a real contrast)

### Banned structures
Binary contrasts: "Не X. А Y." / "Справа не в X. Справа в Y." → just say Y.
Negative listing: "Не X. Не Y. Z." → just say Z.
Dramatic fragments stacked together: three short punchy sentences in a row → merge or cut.
Three-item lists: use one or two. Three is an AI rhythm signature.
Rhetorical questions answered immediately: cut both the question and the answer, keep only the answer.

### False agency — name the actor
Bad: "технологія змінює ринок", "дані свідчать", "ситуація вимагає", "питання залишається"
Fix: хто саме змінює / читає дані / вимагає / не вирішив.

### Passive voice — find the subject
Bad: "було оголошено", "рішення було прийнято", "компанія була змушена"
Fix: хто оголосив / хто прийняв / хто змусив.

### Format bans
No em-dashes (—) except in the headline separator. Use commas or periods instead.
No adverbs: дуже, досить, надзвичайно, вкрай, особливо, значно, суттєво (unless from source).
No paragraph that ends with a one-liner "mic drop" every time — vary endings.`,
};
