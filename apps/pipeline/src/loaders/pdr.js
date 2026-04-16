/**
 * Loader: additional-data/datasets/pdr/tickets.json → pdr_questions table
 *
 * Flattens tickets → individual questions (one row per question).
 * Dedup key: question_id (unique per question from pdr-online.com.ua)
 *
 * Usage:
 *   node src/loaders/pdr.js
 *
 * Options (env):
 *   TICKET_FROM=1  — load from ticket N (default 1)
 *   TICKET_TO=82   — load to ticket N (default all)
 */
import { readFile }        from 'fs/promises';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';
import { pool }            from '../lib/db.js';
import { loadRows }        from '../lib/loader.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = join(__dirname, '..', 'data', 'normalized', 'pdr', 'tickets.json');

const TICKET_FROM = process.env.TICKET_FROM ? parseInt(process.env.TICKET_FROM, 10) : 1;
const TICKET_TO   = process.env.TICKET_TO   ? parseInt(process.env.TICKET_TO,   10) : Infinity;

const COLUMNS  = ['question_id', 'ticket_number', 'question_num', 'text', 'image_url', 'answers', 'correct_answer_num', 'explanation', 'posted'];
const CONFLICT = '(question_id)';

function mapQuestion(q, ticketNumber) {
  return {
    question_id:        q.question_id,
    ticket_number:      ticketNumber,
    question_num:       q.question_num,
    text:               q.text ?? '',
    image_url:          q.image_url ?? null,
    answers:            JSON.stringify(q.answers ?? []),
    correct_answer_num: q.correct_answer_num,
    explanation:        q.explanation ?? '',
    posted:             '{}',
  };
}

async function main() {
  const raw  = await readFile(INPUT_FILE, 'utf-8');
  const data = JSON.parse(raw);

  const tickets = (data.tickets ?? []).filter(
    (t) => t.ticket_number >= TICKET_FROM && t.ticket_number <= TICKET_TO,
  );

  if (!tickets.length) {
    console.error('No tickets in range');
    process.exit(1);
  }

  const rows = [];
  for (const ticket of tickets) {
    if (!Array.isArray(ticket.questions)) continue;
    for (const q of ticket.questions) {
      rows.push(mapQuestion(q, ticket.ticket_number));
    }
  }

  if (!rows.length) {
    console.log('No questions to load');
    await pool.end();
    return;
  }

  console.log(`Loading ${rows.length} questions from ${tickets.length} tickets (${TICKET_FROM}–${tickets.at(-1)?.ticket_number})`);
  const { inserted, skipped } = await loadRows('pdr_questions', rows, { columns: COLUMNS, conflictTarget: CONFLICT });
  console.log(`PDR questions — inserted: ${inserted}, skipped: ${skipped}`);

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
