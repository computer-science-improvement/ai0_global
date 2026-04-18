import { Injectable, Logger } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ClaudeAgent } from '../ai/agents/claude.agent';
import { StructuredLoggerService } from './structured-logger.service';

interface LogLine {
  timestamp?: string;
  level?:     string;
  category?:  string;
  message?:   string;
  [k: string]: unknown;
}

const ANALYZER_SYSTEM_PROMPT = `Ти — аналітик логів Telegram-автоматизації (Node.js/NestJS/PostgreSQL).
На вхід отримуєш JSONL-рядки з категоріями: rss, ai_request, ai_response, db, publication, microlink, http, error.

Твоя задача — проаналізувати надані логи і видати структуровану відповідь українською, ЛАКОНІЧНО.

ВАЖЛИВО: відповідай ЧИСТИМ Telegram-HTML без markdown-обгорток.
НЕ починай з \`\`\`html і не закінчуй \`\`\`. Ніяких потрійних лапок навколо відповіді.
Дозволені теги: <b>, <i>, <u>, <code>, <pre>, <a href="">.

Формат (Telegram-HTML):

<b>🧾 Звіт по логах</b>
<b>Період:</b> <коли ... коли>
<b>Публікації:</b> ✅ N  ❌ M
<b>AI виклики:</b> N (середн. Xs)

<b>🚨 Критичні проблеми</b>
• <причина> — <скільки разів> — де саме (source/channel) — що робити
<pre>{сирий JSON-рядок оригінального лога, який найкраще ілюструє цю проблему}</pre>

<b>⚠️ Попередження</b>
• опис
<pre>{сирий JSON-рядок лога}</pre>

<b>💡 Рекомендації щодо покращення</b>
• конкретні дії з посиланням на файл/сервіс

ПРАВИЛА ЩОДО СИРИХ ЛОГІВ:
- ДЛЯ КОЖНОЇ згаданої проблеми/попередження обовʼязково ДОДАЙ під пунктом 1 найрелевантніший JSON-рядок з вхідних логів всередині <pre>...</pre>.
- Вставляй рядок ТОЧНО як він є у вхідних даних (не змінюй, не скорочуй, не форматуй).
- Якщо рядок довший ніж ~500 символів — скороти посередині через "…" але залиш початок з timestamp+category+message і кінцівку з важливими полями (error, source, channel).
- Якщо одна помилка повторюється — дай ОДИН приклад + зазнач "×N разів".
- Якщо проблем нема — напиши це одним рядком, без сирих логів.`;

@Injectable()
export class LogAnalyzerAgent {
  private readonly logger = new Logger(LogAnalyzerAgent.name);

  constructor(
    private readonly claude: ClaudeAgent,
    private readonly logs:   StructuredLoggerService,
  ) {}

  /**
   * Read recent log lines and ask Claude to analyze them.
   * @param opts.hours     Relative window in hours (default 24h). Ignored if sinceMs is set.
   * @param opts.sinceMs   Absolute lower bound (epoch ms).
   * @param opts.untilMs   Absolute upper bound (epoch ms, defaults to now).
   * @param opts.maxLines  Cap on how many lines to send to AI (keeps prompt size sane)
   */
  async analyze(opts: {
    hours?: number; sinceMs?: number; untilMs?: number; maxLines?: number;
  } = {}): Promise<string> {
    // Guardrails: keep prompt under ~200KB regardless of how big the raw logs
    // are, so Claude doesn't 400 on context length.
    const MAX_PER_LINE_CHARS = 1200;
    const MAX_TOTAL_CHARS    = 180_000;
    const maxLines = opts.maxLines ?? 800;
    const untilMs  = opts.untilMs  ?? Date.now();
    const sinceMs  = opts.sinceMs  ?? untilMs - (opts.hours ?? 24) * 3600_000;

    const windowDesc = this.describeWindow(sinceMs, untilMs);
    const lines = this.readLinesInRange(sinceMs, untilMs, maxLines);
    if (!lines.length) {
      return `<b>🧾 Звіт по логах</b>\n\nЗа період ${windowDesc} немає структурованих логів.`;
    }

    const summary = this.summarize(lines);

    // Render each line as compact JSON; cap per-line to avoid one fat
    // ai_response payload wiping out the budget. Accumulate newest-first and
    // stop when we hit the total cap.
    const rendered: string[] = [];
    let total = 0;
    let dropped = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      let s = JSON.stringify(lines[i]);
      if (s.length > MAX_PER_LINE_CHARS) {
        s = s.slice(0, MAX_PER_LINE_CHARS) + '…(truncated)';
      }
      if (total + s.length + 1 > MAX_TOTAL_CHARS) { dropped = i + 1; break; }
      rendered.push(s);
      total += s.length + 1;
    }
    rendered.reverse();
    const payload = rendered.join('\n');

    const userMessage =
      `Період: ${windowDesc}\n` +
      `• Всього ліній: ${lines.length}` +
        (dropped ? ` (показано ${rendered.length}, обрізано перших ${dropped} через ліміт)` : '') + `\n` +
      `• По категоріях: ${JSON.stringify(summary.byCategory)}\n` +
      `• Публікації: success=${summary.pubSuccess}, failure=${summary.pubFailure}\n` +
      `• AI викликів: ${summary.aiCalls}, помилок: ${summary.aiErrors}\n\n` +
      `Сирі логи (JSONL, найсвіжіші знизу):\n\`\`\`\n${payload}\n\`\`\`\n\n` +
      `Проаналізуй і видай звіт у вказаному форматі.`;

    this.logger.log(
      `analyze: ${lines.length} lines, ${rendered.length} sent, ${total} chars payload`,
    );

    let out: string | null = null;
    try {
      out = await this.claude.chat(
        [
          { role: 'system', content: ANALYZER_SYSTEM_PROMPT },
          { role: 'user',   content: userMessage },
        ],
        { maxTokens: 4096 },
      );
    } catch (err: any) {
      return `<b>🧾 Звіт</b>\n\nАналіз не вдався — Claude викликав помилку: <code>${this.escape(err.message)}</code>`;
    }

    const stripped = this.stripCodeFence(out);
    if (stripped && stripped.trim()) return stripped;

    return (
      `<b>🧾 Звіт</b>\n\n` +
      `Claude повернув пустий результат (може бути rate-limit або overloaded).\n` +
      `Линій у вікні: <b>${lines.length}</b>, відправлено в модель: <b>${rendered.length}</b>, payload ~${total} chars.\n` +
      `Спробуй звузити діапазон: <code>/analyze 1</code> або <code>/analyze HH:MM HH:MM</code>.`
    );
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** Strip surrounding ```html ... ``` fence the model sometimes adds */
  private stripCodeFence(text: string | null): string | null {
    if (!text) return text;
    return text
      .replace(/^\s*```(?:html|HTML)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }

  /** Read JSONL log lines whose timestamp falls into [sinceMs, untilMs]. */
  private readLinesInRange(sinceMs: number, untilMs: number, cap: number): LogLine[] {
    const dir = this.logs.logsDirectory;
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.startsWith('combined-') && f.endsWith('.log'))
        .map((f) => join(dir, f))
        .filter((p) => {
          try {
            // Keep file if its mtime is inside or straddles the window
            const mtime = statSync(p).mtimeMs;
            return mtime >= sinceMs - 24 * 3600_000 && mtime >= sinceMs - 86400_000;
          } catch { return false; }
        })
        .sort();
    } catch (err: any) {
      this.logger.warn(`Cannot list log dir ${dir}: ${err.message}`);
      return [];
    }

    const out: LogLine[] = [];
    for (const file of files) {
      let raw: string;
      try { raw = readFileSync(file, 'utf-8'); }
      catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let obj: LogLine;
        try { obj = JSON.parse(line); } catch { continue; }
        const ts = obj.timestamp ? Date.parse(String(obj.timestamp)) : NaN;
        if (isNaN(ts)) continue;
        if (ts >= sinceMs && ts <= untilMs) out.push(obj);
      }
    }

    return out.slice(-cap);
  }

  /** Human-readable label for a time window (Europe/Kyiv local time assumed from system). */
  private describeWindow(sinceMs: number, untilMs: number): string {
    const fmt = (ms: number) => {
      const d = new Date(ms);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const mon = String(d.getMonth() + 1).padStart(2, '0');
      return `${day}.${mon} ${hh}:${mm}`;
    };
    return `${fmt(sinceMs)} – ${fmt(untilMs)}`;
  }

  private summarize(lines: LogLine[]) {
    const byCategory: Record<string, number> = {};
    let pubSuccess = 0, pubFailure = 0, aiCalls = 0, aiErrors = 0;
    for (const l of lines) {
      const cat = String(l.category ?? 'unknown');
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      if (cat === 'publication') {
        const s = (l as any).data?.status;
        if (s === 'success') pubSuccess++;
        else if (s === 'failure' || s === 'blocked') pubFailure++;
      }
      if (cat === 'ai_response') {
        aiCalls++;
        if ((l as any).data?.error) aiErrors++;
      }
    }
    return { byCategory, pubSuccess, pubFailure, aiCalls, aiErrors };
  }
}
