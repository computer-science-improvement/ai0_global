/**
 * Shared writing skills for Claude prompts in pipeline scripts.
 * Mirrors apps/automation/src/common/ai/skills/ but as plain JS.
 */

export const HUMAN_VOICE_SKILL = `
## Human Voice Rules

### Name the actor, use active verbs
Every sentence needs a subject doing something.
Prefer strong concrete verbs over nominalizations.
Bad: "відбулось підписання угоди" → Fix: "компанії підписали угоду"
Bad: "здійснено виплату" → Fix: "виплатили"
Bad: "прийнято рішення" → Fix: "[хто] вирішив"

### Specifics over abstractions
Numbers, names, dates, places — always over vague descriptions.
Bad: "значна сума" → Fix: "$8 млн"
Bad: "через деякий час" → Fix: "через три роки"
Bad: "ряд компаній" → Fix: "Apple, Google і Meta"

### Sentence rhythm
Mix sentence lengths naturally: one short, one or two medium, repeat.
Short sentence = fact delivery. Medium sentence = context or consequence.
The first sentence of the body should be the heaviest fact, not a setup.

### Connectors that sound human
Use: але, а, хоча, втім, при цьому, водночас, тому, через те що, після того як
Avoid: таким чином, відповідно до цього, у зв'язку з вищесказаним, зважаючи на все вищезазначене

### Tone
Write as an informed person explaining something to a friend.
Neutral and direct. Not excited. Not cautious.
Never interpret, judge, or speculate beyond what the source says.`;

export const ANTI_SLOP_SKILL = `
## Anti-AI Writing Rules

### Banned phrases — cut without replacement
"Варто зазначити", "Слід відзначити", "Важливо розуміти", "Не можна не згадати"
"Як відомо", "Очевидно що", "Безумовно", "Звичайно ж"
"Як ніколи раніше", "У сучасному світі", "В умовах сьогодення"
"Це свідчить про", "Дане питання", "На сьогоднішній день", "З огляду на це"
"Не лише… а й", "Не тільки… але й"
"Це важливо", "Варто підкреслити", "Особливо важливо"

### Banned structures
Binary contrasts: "Не X. А Y." → just say Y.
Three-item lists: use one or two. Three is an AI rhythm signature.
Rhetorical questions answered immediately: cut both, keep only the answer.
Dramatic fragments stacked together: three short punchy sentences in a row → merge or cut.

### False agency — name the actor
Bad: "технологія змінює ринок", "дані свідчать", "ситуація вимагає"
Fix: хто саме змінює / читає дані / вимагає.

### Passive voice — find the subject
Bad: "було оголошено", "рішення було прийнято", "компанія була змушена"
Fix: хто оголосив / хто прийняв / хто змусив.

### Format bans
No adverbs: дуже, досить, надзвичайно, вкрай, особливо, значно, суттєво.
No paragraph that ends with a one-liner "mic drop" every time — vary endings.`;

/** Combine multiple skills into a single system prompt block */
export function buildSystemPrompt(base, ...skills) {
  if (!skills.length) return base;
  return `${base}\n\n---\n${skills.join('\n\n---\n')}`;
}
