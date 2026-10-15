/**
 * Spec 037 FR-011 (T11): the network's AI posters (`ai_posters`, `docs/data/ai-posters.json`, imported on /app/data
 * as a dataset; the writer finds them with library_catalog / query_data and puts the row's `image_url` into
 * `media`). The code recognises a poster by its file name (`<id>.png`, whatever the host), so a re-hosted copy is
 * still a poster. `keywords` are word stems of the poster's `use_for`: a post is on the poster's topic when one of
 * them is in the title / lead / slot topic, or at least twice in the text. A test keeps this list equal to the
 * dataset file.
 */
export interface AiPoster {
  id: string;
  title: string;
  useFor: string;
  keywords: readonly string[];
}

export const AI_POSTERS: readonly AiPoster[] = [
  { id: '01-prompt',             title: 'Prompt',               useFor: 'пост про один промпт або техніку промптингу', keywords: ['промпт', 'prompt'] },
  { id: '02-community-prompt',   title: 'Community prompt',     useFor: 'промпт від спільноти, добірка промптів', keywords: ['промпт', 'prompt'] },
  { id: '03-context-window',     title: 'Context window',       useFor: 'контекстне вікно, довгий контекст, токени', keywords: ['контекстн', 'довгий контекст', 'context window', 'токен', 'token'] },
  { id: '04-mcp-server',         title: 'MCP server',           useFor: 'MCP-сервер, підключення AI до сервісу', keywords: ['mcp'] },
  { id: '05-tool-function-call', title: 'Tool / Function call', useFor: 'виклик інструментів, function calling, API', keywords: ['виклик інструмент', 'function call', 'tool call', 'tool use', 'api'] },
  { id: '06-plugin',             title: 'Plugin',               useFor: 'плагін, розширення для AI-інструмента', keywords: ['плагін', 'plugin', 'розширенн', 'extension'] },
  { id: '07-hook',               title: 'Hook',                 useFor: 'хуки, автоматизація подій', keywords: ['хук', 'hook'] },
  { id: '08-agent',              title: 'Agent',                useFor: 'AI-агент, автономний асистент', keywords: ['агент', 'agent', 'асистент', 'assistant'] },
  { id: '09-subagents',          title: 'Subagents',            useFor: 'субагенти, делегування задач, мультиагентні системи', keywords: ['субагент', 'subagent', 'мультиагент', 'multi-agent', 'делегуванн'] },
  { id: '10-harness',            title: 'Harness',              useFor: 'harness, обвʼязка агента, середовище запуску', keywords: ['harness', 'обвʼязк', 'середовище запуску'] },
  { id: '11-workflow',           title: 'Workflow',             useFor: 'воркфлоу, пайплайн, ланцюжок кроків', keywords: ['воркфлоу', 'workflow', 'пайплайн', 'pipeline', 'ланцюжок'] },
  { id: '12-skill',              title: 'Skill',                useFor: 'скіл, навичка агента, інструкції', keywords: ['скіл', 'skill', 'навичк'] },
  { id: '13-memory',             title: 'Memory',               useFor: 'памʼять агента', keywords: ['памʼят', 'memory'] },
  { id: '14-rag',                title: 'RAG',                  useFor: 'RAG, пошук по базі знань', keywords: ['rag', 'retrieval', 'базі знань', 'база знань', 'бази знань'] },
  { id: '15-eval',               title: 'Eval',                 useFor: 'evals, тестування якості моделей', keywords: ['eval', 'бенчмарк', 'benchmark', 'тестуванн'] },
  { id: '16-guardrails',         title: 'Guardrails',           useFor: 'guardrails, безпека, обмеження моделі', keywords: ['guardrail', 'безпек', 'обмеженн'] },
  { id: '17-fine-tune-model',    title: 'Fine-tune / Model',    useFor: 'нова модель, файнтюнінг, реліз моделі', keywords: ['файнтюн', 'fine-tun', 'finetun', 'модел', 'model'] },
];

const BY_FILE = new Map(AI_POSTERS.map((p) => [p.id, p]));

/** The poster an image URL shows (by its `<id>.png` file name), or null. */
export function posterOf(url: string): AiPoster | null {
  let path: string;
  try { path = new URL(url.trim()).pathname; } catch { return null; }
  const file = decodeURIComponent(path.split('/').pop() ?? '').toLowerCase();
  const m = /^(.+)\.(?:png|jpe?g|webp)$/.exec(file);
  return m ? BY_FILE.get(m[1]) ?? null : null;
}

/** The apostrophes of Ukrainian (ʼ ' ’ `) as one, lower case. */
const fold = (s: string): string => s.toLowerCase().replace(/['’`]/g, 'ʼ');

function count(text: string, stem: string): number {
  const esc = fold(stem).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return fold(text).match(new RegExp(`(?<![\\p{L}\\p{N}])${esc}`, 'gu'))?.length ?? 0;
}

/** What a post says about its topic: the headline parts (title, lead, the slot's topic) and the reader text. */
export interface PosterTopicInput {
  head: ReadonlyArray<string | null | undefined>;
  text: string;
}

/**
 * Whether the post is on the poster's topic: a keyword in the headline parts, or at least twice in the text (one
 * passing mention, «уроки й промпти від OpenAI» in a list of courses, is not the topic).
 */
export function posterFitsTopic(poster: AiPoster, i: PosterTopicInput): boolean {
  const head = i.head.filter((x): x is string => !!x && !!x.trim()).join('\n');
  return poster.keywords.some((k) => count(head, k) > 0 || count(i.text, k) >= 2);
}
