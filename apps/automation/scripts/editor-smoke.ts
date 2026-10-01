/**
 * One-off live check of the editor model on YOUR OpenRouter key (costs < $0.001).
 * Verifies the model answers in Ukrainian and returns a structured tool call.
 *
 *   cd apps/automation && npx tsx --env-file=../../.env scripts/editor-smoke.ts
 *
 * Uses EDITOR_MODEL_EXECUTOR or the default (z-ai/glm-5.3-flash). Publishes nothing.
 */
import { OpenRouterClient } from '../src/editor/llm/openrouter.client';
import { resolveModel } from '../src/editor/llm/model-registry';

async function main() {
  const profile = resolveModel('executor', (k) => process.env[k]);
  const llm = new OpenRouterClient({ apiKey: process.env.OPENROUTER_API_KEY, baseUrl: process.env.OPENROUTER_BASE_URL });
  const res = await llm.chat({
    model: profile.model,
    maxTokens: 400,
    temperature: 0.3,
    messages: [
      { role: 'system', content: 'Ти редактор українського Telegram-каналу про космос. Завжди відповідай викликом інструмента.' },
      { role: 'user', content: 'Збережи заголовок для поста про туманність Кільце (до 80 символів, українською).' },
    ],
    tools: [{
      name: 'save_title',
      description: 'Зберегти заголовок поста',
      parameters: { type: 'object', properties: { title: { type: 'string', maxLength: 80 } }, required: ['title'], additionalProperties: false },
    }],
  });
  const call = res.message.toolCalls?.[0];
  console.log(`model:       ${profile.model}`);
  console.log(`tool call:   ${call ? `${call.name}(${call.arguments})` : 'NONE'}`);
  console.log(`text:        ${res.message.content ?? ''}`);
  console.log(`tokens:      ${res.usage.promptTokens} in / ${res.usage.completionTokens} out, $${res.usage.costUsd.toFixed(6)}`);
  let ok = !!call && call.name === 'save_title';
  if (ok) {
    try {
      const t = String(JSON.parse(call!.arguments).title ?? '');
      ok = /[Ѐ-ӿ]/.test(t) && t.length <= 80;
    } catch { ok = false; }
  }
  console.log(ok ? '✅ OK — tool calling + Ukrainian work; editor can run in shadow mode.' : '❌ FAIL — the model did not return a valid tool call; try another provider/model before enabling the editor.');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
