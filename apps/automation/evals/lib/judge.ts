import { OpenRouterClient } from '../../src/editor/llm/openrouter.client';

export interface JudgeInput {
  channelBrief: string;
  slotTopic:    string;
  sourceText:   string;   // what the agent had access to ('' if original)
  post:         string;   // rendered post (plain text)
}

export interface JudgeScore {
  voice:     number;  // natural Ukrainian, no AI clichés
  accuracy:  number;  // no claims beyond the source; no fabrication
  relevance: number;  // fits slot topic + channel brief
  craft:     number;  // structure, hook, length, formatting fit
  overall:   number;
  issues:    string[];
  costUsd:   number;
  model:     string;
}

const RUBRIC = `Ти — суворий шеф-редактор українського медіа. Оціни ОДИН пост для Telegram-каналу.
Шкала 1–5 для кожного критерію (5 — готово до публікації без правок, 3 — прийнятно з правками, 1 — не можна публікувати):
- voice: жива природна українська, без канцеляриту, кальок і AI-штампів ("варто зазначити", "у сучасному світі", пафос).
- accuracy: кожне фактичне твердження підтверджується наданим джерелом; вигадані цифри/дати/цитати = 1. Якщо джерела немає, оцінюй правдоподібність і відсутність конкретики, яку неможливо перевірити.
- relevance: пост відповідає темі слоту й тематиці каналу.
- craft: сильний перший рядок, структура, довжина під Telegram, доречність формату.
overall — загальна оцінка 1–5 (не середнє, а твоє рішення як редактора).
issues — до 5 конкретних проблем коротко, українською.
Відповідай ЛИШЕ JSON: {"voice":n,"accuracy":n,"relevance":n,"craft":n,"overall":n,"issues":["..."]}`;

export async function judgePost(apiKey: string, model: string, i: JudgeInput): Promise<JudgeScore | { error: string }> {
  const llm = new OpenRouterClient({ apiKey });
  const res = await llm.chat({
    model, maxTokens: 1500, temperature: 0,
    messages: [
      { role: 'system', content: RUBRIC },
      { role: 'user', content: `Канал: ${i.channelBrief}\nТема слоту: ${i.slotTopic}\n\n=== ДЖЕРЕЛО ===\n${i.sourceText.slice(0, 6000) || '(немає — власний текст)'}\n\n=== ПОСТ ===\n${i.post}` },
    ],
  });
  const raw = (res.message.content ?? '').replace(/```(?:json)?/g, '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { error: `judge returned no JSON: ${raw.slice(0, 200)}` };
  try {
    const j = JSON.parse(m[0]);
    const n = (v: unknown) => Math.max(1, Math.min(5, Number(v) || 1));
    return {
      voice: n(j.voice), accuracy: n(j.accuracy), relevance: n(j.relevance), craft: n(j.craft), overall: n(j.overall),
      issues: Array.isArray(j.issues) ? j.issues.map(String).slice(0, 5) : [],
      costUsd: res.usage.costUsd, model,
    };
  } catch (e: any) {
    return { error: `judge JSON parse failed: ${e.message}` };
  }
}
