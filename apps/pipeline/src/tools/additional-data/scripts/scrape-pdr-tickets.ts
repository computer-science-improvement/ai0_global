/**
 * Scraper for pdr-online.com.ua — ПДР тести по білетах.
 *
 * Run:
 *   npx playwright install chromium   (first time only)
 *   npx tsx src/tools/additional-data/scripts/scrape-pdr-tickets.ts
 *
 * Options (env):
 *   TICKET_FROM=1   start ticket (default 1)
 *   TICKET_TO=82    end ticket (default 82)
 *   HEADLESS=false  show browser (default true)
 */

import { chromium, type Page, type Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL    = 'https://pdr-online.com.ua/testi/testi-po-biletah/';
const TICKET_FROM = Number(process.env.TICKET_FROM ?? 1);
const TICKET_TO   = Number(process.env.TICKET_TO   ?? 82);
const HEADLESS    = process.env.HEADLESS !== 'false';

const OUTPUT_FILE = path.join(__dirname, '..', '..', '..', 'data', 'normalized', 'pdr', 'tickets.json');
const AUTH_FILE   = path.join(__dirname, '..', '..', '..', 'data', 'normalized', 'pdr', 'auth.json');

// ─── Types ────────────────────────────────────────────────────────────────────

interface Answer {
  num: number;
  text: string;
}

interface Question {
  question_id:        number;
  question_num:       number;
  text:               string;
  image_url:          string | null;
  answers:            Answer[];
  correct_answer_num: number;
  explanation:        string;
}

interface Ticket {
  ticket_number: number;
  questions:     Question[];
}

interface Output {
  source:          string;
  scraped_at:      string;
  total_tickets:   number;
  total_questions: number;
  tickets:         Ticket[];
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function readOutput(): Output {
  if (fs.existsSync(OUTPUT_FILE)) {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
  }
  return {
    source: 'pdr-online.com.ua',
    scraped_at: new Date().toISOString(),
    total_tickets: 0,
    total_questions: 0,
    tickets: [],
  };
}

function saveQuestion(ticketNum: number, question: Question): void {
  const output = readOutput();
  let ticket = output.tickets.find(t => t.ticket_number === ticketNum);
  if (!ticket) {
    ticket = { ticket_number: ticketNum, questions: [] };
    output.tickets.push(ticket);
    output.tickets.sort((a, b) => a.ticket_number - b.ticket_number);
  }
  const existing = ticket.questions.findIndex(q => q.question_id === question.question_id);
  if (existing >= 0) ticket.questions[existing] = question;
  else ticket.questions.push(question);

  output.total_tickets   = output.tickets.length;
  output.total_questions = output.tickets.reduce((s, t) => s + t.questions.length, 0);
  output.scraped_at      = new Date().toISOString();

  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function waitMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Per-question scraper ─────────────────────────────────────────────────────

/**
 * Скрапить одне питання:
 * 1. Читає текст, відповіді, картинку з DOM
 * 2. Клікає на першу відповідь (будь-яку) — сервер повертає {correct, comment} через XHR
 * 3. Читає correct та explanation з DOM після кліку
 */
async function scrapeQuestion(
  page: Page,
  questionId: string,
  questionNum: number
): Promise<Question | null> {
  // ── Текст, відповіді, картинка — читаємо напряму з DOM ────────────────────
  const meta = await page.evaluate((qId) => {
    const block = document.querySelector<HTMLElement>(
      `.question[data-question-holder-id="${qId}"]`
    );
    if (!block) return null;

    // Текст питання
    const holderEl = block.querySelector('.question_holder');
    let text = '';
    if (holderEl) {
      const clone = holderEl.cloneNode(true) as Element;
      clone.querySelectorAll('span').forEach(s => s.remove());
      text = clone.textContent?.trim() ?? '';
    }

    // Картинка
    let image_url: string | null = null;
    for (const img of block.querySelectorAll<HTMLImageElement>('img')) {
      const src = img.src ?? '';
      if (src && !src.includes('pagespeed.gif') && !src.includes('1.gif')) {
        image_url = src;
        break;
      }
    }

    // Відповіді
    const answers: Array<{ num: number; text: string }> = [];
    block.querySelectorAll('.question_answer_holder li').forEach(li => {
      const a = li.querySelector<HTMLElement>('a.answer');
      const num = parseInt(a?.getAttribute('data-answer-num') ?? '-1', 10);
      const txt = li.querySelector('p')?.textContent?.trim()
        ?? a?.textContent?.trim()
        ?? '';
      if (num >= 0) answers.push({ num, text: txt });
    });

    return { text, image_url, answers };
  }, questionId);

  if (!meta) return null;

  // ── Клік на відповідь (щоб питання стало answered) ────────────────────────
  const answerSel = `.question[data-question-holder-id="${questionId}"] a.answer`;
  await page.locator(answerSel).first().click({ timeout: 6_000 });

  // Чекаємо поки питання стане "answered"
  await page.waitForFunction(
    (qId) => document.querySelector(`.question[data-question-holder-id="${qId}"]`)
                      ?.classList.contains('answered'),
    questionId,
    { timeout: 8_000 }
  ).catch(() => {});

  // ── Правильна відповідь — читаємо з DOM ───────────────────────────────────
  const correct_answer_num = await page.evaluate((qId) => {
    const block = document.querySelector(`.question[data-question-holder-id="${qId}"]`);
    const correctEl = block?.querySelector<HTMLElement>('a.answer.correct');
    if (correctEl) return parseInt(correctEl.getAttribute('data-answer-num') ?? '-1', 10);
    return -1;
  }, questionId);

  // ── Пояснення — клікаємо кнопку "Пояснення" та читаємо з DOM ──────────────
  let explanation = '';
  try {
    // Запам'ятовуємо поточний текст (щоб визначити момент оновлення)
    const prevText = await page.evaluate(() =>
      document.querySelector('.instructor_comment .instructor_comment_text.content')
               ?.textContent?.trim() ?? '__EMPTY__'
    );

    // Клікаємо кнопку "Пояснення" конкретного питання
    const explBtnSel = `.question[data-question-holder-id="${questionId}"] .question_comment_call`;
    await page.locator(explBtnSel).click({ timeout: 4_000 });

    // Чекаємо поки текст у .instructor_comment_text.content зміниться
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector(
          '.instructor_comment .instructor_comment_text.content'
        );
        const t = el?.textContent?.trim() ?? '';
        return t.length > 0 && t !== prev;
      },
      prevText,
      { timeout: 8_000 }
    );

    // Читаємо текст (textContent читається навіть при display:none)
    explanation = await page.evaluate(() => {
      const el = document.querySelector(
        '.instructor_comment .instructor_comment_text.content'
      );
      return el?.textContent?.trim() ?? '';
    });

    // Закриваємо popup
    await page.locator('button.popup_close').click({ timeout: 2_000 }).catch(() => {});
    await waitMs(150);
  } catch {
    // Пояснення не вдалось отримати — залишаємо порожнім
  }

  return {
    question_id:        parseInt(questionId, 10),
    question_num:       questionNum,
    text:               meta.text,
    image_url:          meta.image_url,
    answers:            meta.answers,
    correct_answer_num,
    explanation,
  };
}

// ─── Ticket scraper ───────────────────────────────────────────────────────────

async function scrapeTicket(page: Page, ticketNum: number): Promise<void> {
  console.log(`\n[Ticket ${ticketNum}] Navigating...`);

  await page.goto(`${BASE_URL}?ticket=${ticketNum}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  // Чекаємо поки з'являться питання
  await page.waitForSelector('.question', { timeout: 15_000 });

  // Закриємо popup якщо є
  const closePopup = page.locator('#sing_pop .close_popup, .form_popup .close_popup, .popup .close_popup').first();
  if (await closePopup.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closePopup.click({ force: true }).catch(() => {});
    await waitMs(300);
  }

  // Зберемо всі ID питань з DOM (всі 20 вже завантажені)
  const questionIds: string[] = await page.evaluate(() => {
    return Array.from(
      document.querySelectorAll('.question[data-question-holder-id]')
    ).map(el => el.getAttribute('data-question-holder-id') ?? '').filter(Boolean);
  });

  console.log(`[Ticket ${ticketNum}] Found ${questionIds.length} questions`);

  for (let qi = 0; qi < questionIds.length; qi++) {
    const qId = questionIds[qi];
    const qNum = qi + 1;

    try {
      const question = await scrapeQuestion(page, qId, qNum);

      if (!question) {
        console.warn(`  Q${qNum}/${questionIds.length} id=${qId} — NOT FOUND in DOM, skipping`);
        continue;
      }

      saveQuestion(ticketNum, question);

      const status  = question.correct_answer_num >= 0
        ? `correct=${question.correct_answer_num}`
        : 'no-correct-found';
      const hasExp  = question.explanation ? '✓expl' : '—expl';
      const hasImg  = question.image_url   ? '✓img'  : '—img';
      console.log(`  Q${qNum}/${questionIds.length} id=${qId} answers=${question.answers.length} ${status} ${hasExp} ${hasImg}`);
    } catch (err: any) {
      console.error(`  Q${qNum}/${questionIds.length} id=${qId} ERROR: ${err.message}`);
    }

    // Невеличка затримка між питаннями
    await waitMs(300);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('PDR tickets scraper — pdr-online.com.ua');
  console.log(`Tickets: ${TICKET_FROM}–${TICKET_TO}`);
  console.log(`Output:  ${OUTPUT_FILE}`);
  console.log(`Headless: ${HEADLESS}`);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: HEADLESS });

    const hasAuth = fs.existsSync(AUTH_FILE);
    if (hasAuth) console.log(`Loading auth session from ${AUTH_FILE}`);
    else         console.warn('No auth session — run pdr-login.ts first (or leave anonymous)');

    const context = await browser.newContext({
      storageState: hasAuth ? AUTH_FILE : undefined,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // Блокуємо ресурси які не потрібні для парсингу
    await page.route('**/*', (route, request) => {
      const url = request.url();
      const resourceType = request.resourceType();

      // Пропускаємо: документи, скрипти, XHR/Fetch (для API), картинки з тестів
      if (
        resourceType === 'document' ||
        resourceType === 'script' ||
        resourceType === 'xhr' ||
        resourceType === 'fetch' ||
        (resourceType === 'image' && url.includes('/assets/images/pdr/tests/'))
      ) {
        route.continue();
        return;
      }

      // Блокуємо все решта (шрифти, css, трекери тощо)
      if (
        resourceType === 'stylesheet' ||
        resourceType === 'font' ||
        resourceType === 'media' ||
        url.includes('googletagmanager') ||
        url.includes('google-analytics') ||
        url.includes('facebook') ||
        url.includes('clarity.ms')
      ) {
        route.abort();
        return;
      }

      route.continue();
    });

    for (let t = TICKET_FROM; t <= TICKET_TO; t++) {
      try {
        await scrapeTicket(page, t);
      } catch (err: any) {
        console.error(`[Ticket ${t}] FATAL ERROR: ${err.message}`);
      }
      // Затримка між білетами
      await waitMs(600);
    }

    const output = readOutput();
    console.log(`\nDone! Tickets: ${output.total_tickets}, Questions: ${output.total_questions}`);
    console.log(`Saved: ${OUTPUT_FILE}`);
  } finally {
    await browser?.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});