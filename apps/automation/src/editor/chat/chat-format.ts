/**
 * How a dashboard chat answer may be formatted: the subset the dashboard's markdown-lite renders
 * (apps/dashboard/src/lib/markdown-lite.tsx) — change both together. Anything else shows as raw text.
 * Goes into every chat prompt (composer / named agent, @ai0, @manager); post text keeps its own markup (PostSpec).
 */
export const CHAT_FORMAT_RULE = [
  '## Формат відповіді в чаті',
  'Чат показує лише такий markdown: абзаци; списки «- » і «1. »; заголовки «## »; **жирний**, _курсив_, ~~закреслений~~, `код`; [текст](https://посилання); блок коду між ```; цитата «> »; роздільник «---»; таблиця (рядок заголовка, рядок |---|, далі рядки).',
  'Таблиця — лише для порівняння кількох обʼєктів за 2–5 ознаками (канали, цифри). Символ | усередині клітинки пиши як \\|. Одну-дві речі подавай текстом чи списком.',
  'Не використовуй HTML, вкладені списки, зображення, виноски й чекбокси — вони покажуться сирим текстом. Це правило лише для відповідей у чаті; текст поста пишеш за правилами PostSpec.',
].join('\n');

/** Spec 062 FR-001: the history shows each turn with system footers; the model must not write its own. Goes into every chat prompt. */
export const NO_SYSTEM_FOOTERS_RULE = 'Не пиши рядки [дії: …], [чернетки: …] чи «@handle:» — їх додає система.';
