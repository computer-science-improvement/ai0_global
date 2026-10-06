/**
 * Loader: additional-data/datasets/pdr/tickets.json → the `pdr_questions` dataset (data store, spec 032)
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
import { loadData, schemaFor, formatLoad } from '../lib/loader.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = join(__dirname, '..', 'data', 'normalized', 'pdr', 'tickets.json');

const TICKET_FROM = process.env.TICKET_FROM ? parseInt(process.env.TICKET_FROM, 10) : 1;
const TICKET_TO   = process.env.TICKET_TO   ? parseInt(process.env.TICKET_TO,   10) : Infinity;

function mapQuestion(q, ticketNumber) {
  return {
    question_id:        q.question_id,
    ticket_number:      ticketNumber,
    question_num:       q.question_num,
    text:               q.text ?? '',
    image_url:          q.image_url ?? null,
    answers:            q.answers ?? [],
    correct_answer_num: q.correct_answer_num,
    explanation:        q.explanation ?? '',
    source_name:        'pdr-online.com.ua',
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
  const r = await loadData(schemaFor('pdr'), rows, { filename: 'pdr/tickets.json' });
  console.log(`PDR questions — ${formatLoad(r)}`);

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
