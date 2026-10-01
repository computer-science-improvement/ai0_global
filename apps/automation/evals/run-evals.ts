/**
 * Live evals for the editor agents (real LLM via OpenRouter, fixture web, fake Telegram, scratch Postgres).
 *
 *   cd apps/automation
 *   EVAL_DB_URL='postgres://ai0@localhost/ai0?host=/tmp/pgsockXXXX&port=54329' \
 *     npx tsx --env-file=../../.env evals/run-evals.ts [--case <id>[,<id>]] [--reps 3] [--judge] [--judge-model z-ai/glm-5.3] [--max-usd 1]
 *
 * Safety: refuses any DB that looks real (has bots/meta accounts or > 5000 published posts).
 * Nothing is ever sent to Telegram; the web is fixtures only.
 */
import { Pool } from 'pg';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildStack } from './lib/stack';
import { resetChannel, resetLibrary } from './lib/seed';
import { runCost } from './lib/graders';
import { judgePost, JudgeScore } from './lib/judge';
import type { CaseOutcome, EvalCase } from './lib/case';
import { EXECUTOR_CASES } from './cases/executor';
import { PLANNER_REVIEWER_CASES } from './cases/planner-reviewer';
import { localDate, zonedToUtc } from '../src/editor/roles/time';
import { resolveModel } from '../src/editor/llm/model-registry';

const ALL: EvalCase[] = [...EXECUTOR_CASES, ...PLANNER_REVIEWER_CASES];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1]?.startsWith('--') ? 'true' : process.argv[i + 1] ?? 'true') : undefined;
}

async function assertScratchDb(pool: Pool): Promise<void> {
  const q = async (sql: string) => Number((await pool.query(sql)).rows[0]?.n ?? 0);
  const bots = await q(`SELECT COUNT(*)::int AS n FROM my_bots`).catch(() => 0);
  const meta = await q(`SELECT COUNT(*)::int AS n FROM meta_accounts`).catch(() => 0);
  const posts = await q(`SELECT COUNT(*)::int AS n FROM published_posts`).catch(() => 0);
  if (bots > 0 || meta > 0 || posts > 5000) {
    throw new Error(`EVAL_DB_URL looks like a real database (bots=${bots}, meta=${meta}, posts=${posts}). Evals only run on a scratch DB.`);
  }
  await pool.query(`SELECT 1 FROM editor_channels LIMIT 1`); // migrations applied?
}

interface Row {
  case: string; rep: number; role: string; pass: boolean; hardFailed: string[]; softFailed: string[];
  status: string; terminal: string; steps: number; costUsd: number; tokens: string; seconds: number;
  toolsUsed: string[]; toolErrors: string[]; judge?: JudgeScore | { error: string }; post: string; checks: CaseOutcome['checks'];
}

async function main() {
  const dbUrl = process.env.EVAL_DB_URL;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!dbUrl) throw new Error('EVAL_DB_URL is required (scratch Postgres with all migrations applied)');
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  const only = arg('case')?.split(',');
  const reps = Number(arg('reps') ?? 1);
  const doJudge = arg('judge') === 'true';
  const judgeModel = arg('judge-model') ?? 'z-ai/glm-5.3';
  const maxUsd = Number(arg('max-usd') ?? 1);
  const cases = ALL.filter((c) => !only || only.includes(c.id));
  if (!cases.length) throw new Error(`no cases match ${only}; available: ${ALL.map((c) => c.id).join(', ')}`);

  const pool = new Pool({ connectionString: dbUrl, max: 4 });
  await assertScratchDb(pool);

  // Fixed clock: today 10:30 Kyiv — inside posting hours, plenty of day left to plan.
  const now = zonedToUtc(localDate(new Date(), 'Europe/Kyiv'), '10:30', 'Europe/Kyiv');
  const env = (k: string) => process.env[k];
  const model = resolveModel('executor', env).model;
  console.log(`editor evals · model ${model} · ${cases.length} cases × ${reps} reps${doJudge ? ` · judge ${judgeModel}` : ''} · cap $${maxUsd}\n`);

  const rows: Row[] = [];
  let spent = 0;
  for (const c of cases) {
    for (let rep = 1; rep <= reps; rep++) {
      if (spent >= maxUsd) { console.log(`⛔ budget cap $${maxUsd} reached — stopping`); break; }
      await resetChannel(pool, c.channel);
      await resetLibrary(pool);
      const web = c.web();
      const stack = buildStack({ pool, web, now: () => now, apiKey, env });
      const t0 = Date.now();
      let out: CaseOutcome;
      try {
        out = await c.execute({ pool, now, web, stack });
      } catch (e: any) {
        out = { runId: null, status: 'crash', checks: [{ name: 'case crashed', pass: false, detail: e?.message ?? String(e) }] };
      }
      const cost = await runCost(pool, out.runId);
      let judge: Row['judge'];
      if (doJudge && out.judge && out.judge.post) {
        judge = await judgePost(apiKey, judgeModel, out.judge).catch((e) => ({ error: String(e?.message ?? e) }));
        if (judge && 'costUsd' in judge) spent += judge.costUsd;
      }
      spent += cost.costUsd;
      const hardFailed = out.checks.filter((k) => !k.pass && !k.soft).map((k) => k.name);
      const softFailed = out.checks.filter((k) => !k.pass && k.soft).map((k) => k.name);
      const row: Row = {
        case: c.id, rep, role: c.role, pass: hardFailed.length === 0, hardFailed, softFailed,
        status: out.status, terminal: out.terminalTool ?? '-', steps: cost.steps, costUsd: cost.costUsd,
        tokens: `${cost.promptTokens}/${cost.completionTokens}`, seconds: Math.round((Date.now() - t0) / 1000),
        toolsUsed: out.toolsUsed ?? [], toolErrors: out.toolErrors ?? [], judge, post: out.post ?? '', checks: out.checks,
      };
      rows.push(row);
      const j = judge && 'overall' in judge ? ` · judge ${judge.overall}/5` : '';
      console.log(`${row.pass ? '✅' : '❌'} ${c.id} #${rep} · ${row.terminal} · ${row.steps} steps · $${row.costUsd.toFixed(4)} · ${row.seconds}s${j}`);
      for (const k of out.checks) if (!k.pass) console.log(`   ${k.soft ? '⚠️ ' : '✗ '}${k.name}${k.detail ? ` — ${k.detail}` : ''}`);
      if (row.toolErrors.length) console.log(`   tool errors: ${row.toolErrors.join(', ')}`);
    }
    await resetChannel(pool, c.channel);
  }
  await resetLibrary(pool);
  await pool.end();

  const passed = rows.filter((r) => r.pass).length;
  const judged = rows.map((r) => r.judge).filter((j): j is JudgeScore => !!j && 'overall' in j);
  const avg = (k: keyof JudgeScore) => judged.length ? (judged.reduce((s, j) => s + Number(j[k]), 0) / judged.length).toFixed(2) : '-';
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  console.log(`\n${passed}/${rows.length} passed · agent spend $${total.toFixed(4)} · total incl. judge $${spent.toFixed(4)}${judged.length ? ` · judge overall avg ${avg('overall')}` : ''}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify({ model, judgeModel: doJudge ? judgeModel : null, now, rows }, null, 2));
  writeFileSync(join(dir, `${stamp}.md`), report(model, doJudge ? judgeModel : null, rows, total, spent, avg));
  console.log(`report: evals/results/${stamp}.md`);
  process.exit(passed === rows.length ? 0 : 1);
}

function report(model: string, judgeModel: string | null, rows: Row[], agentUsd: number, totalUsd: number, avg: (k: keyof JudgeScore) => string): string {
  const lines = [
    `# Editor evals — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `Model: \`${model}\`${judgeModel ? ` · judge: \`${judgeModel}\`` : ''} · passed **${rows.filter((r) => r.pass).length}/${rows.length}** · agent spend $${agentUsd.toFixed(4)} (avg $${(agentUsd / Math.max(rows.length, 1)).toFixed(4)}/run) · total $${totalUsd.toFixed(4)}`,
    judgeModel ? `\nJudge averages: voice ${avg('voice')} · accuracy ${avg('accuracy')} · relevance ${avg('relevance')} · craft ${avg('craft')} · **overall ${avg('overall')}**` : '',
    '',
    '| case | rep | result | terminal | steps | $ | tokens in/out | s | judge |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.case} | ${r.rep} | ${r.pass ? '✅' : '❌'} | ${r.terminal} | ${r.steps} | ${r.costUsd.toFixed(4)} | ${r.tokens} | ${r.seconds} | ${r.judge && 'overall' in r.judge ? `${r.judge.overall}/5` : '-'} |`),
    '',
  ];
  for (const r of rows) {
    lines.push(`## ${r.case} #${r.rep} — ${r.pass ? 'PASS' : 'FAIL'}`, '');
    for (const k of r.checks) lines.push(`- ${k.pass ? '✅' : k.soft ? '⚠️' : '❌'} ${k.name}${k.detail ? ` — \`${String(k.detail).slice(0, 160)}\`` : ''}`);
    lines.push('', `Tools: ${r.toolsUsed.join(' → ') || '-'}`);
    if (r.toolErrors.length) lines.push(`Tool errors (recovered or not): ${r.toolErrors.join(', ')}`);
    if (r.judge) lines.push('', 'overall' in r.judge
      ? `Judge: voice ${r.judge.voice} · accuracy ${r.judge.accuracy} · relevance ${r.judge.relevance} · craft ${r.judge.craft} · overall **${r.judge.overall}**${r.judge.issues.length ? `\n${r.judge.issues.map((i) => `  - ${i}`).join('\n')}` : ''}`
      : `Judge error: ${r.judge.error}`);
    if (r.post) lines.push('', '```', r.post.slice(0, 2500), '```');
    lines.push('');
  }
  return lines.join('\n');
}

main().catch((e) => { console.error('❌', e?.message ?? e); process.exit(2); });
