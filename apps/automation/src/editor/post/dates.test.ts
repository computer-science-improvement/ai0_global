import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, dateFromUrl, formatLocalStamp, mentionInstant, MONTHS_GENITIVE, normalizePublishedAt, parseDateMentions, sourceAgeHours, weekdayOf,
} from './dates';

const KYIV = 'Europe/Kyiv';
/** 08.10.2026 14:00 Kyiv (UTC+3), a Thursday. */
const AT = { publishedAt: '2026-10-08T11:00:00Z', timezone: KYIV };
const parse = (text: string, at = AT) => parseDateMentions(text, at);

test('dates: calendar helpers (weekdays of October 2026, month ends)', () => {
  assert.equal(weekdayOf('2026-10-13'), 2, '13.10.2026 is a Tuesday');
  assert.equal(weekdayOf('2026-10-14'), 3);
  assert.equal(weekdayOf('2026-10-25'), 0, '25.10.2026 is a Sunday (DST end)');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('dates: every genitive month with a day; the year is the one nearest the publish day', () => {
  MONTHS_GENITIVE.forEach((month, i) => {
    const [m] = parse(`Подія відбудеться 5 ${month}.`);
    assert.equal(m?.kind, 'date', month);
    assert.equal(m!.date!.slice(5), `${String(i + 1).padStart(2, '0')}-05`, month);
  });
  assert.equal(parse('12 жовтня')[0].date, '2026-10-12');
  assert.equal(parse('5 січня')[0].date, '2027-01-05', 'January after an October post is next year');
  assert.equal(parse('5 травня')[0].date, '2026-05-05');
  assert.equal(parse('12-го жовтня')[0].date, '2026-10-12');
  assert.deepEqual(parse('12 жовтня 2027 року').map((m) => [m.date, m.explicitYear, m.historical]), [['2027-10-12', true, undefined]]);
  assert.deepEqual(parse('31 лютого'), [], 'no such day');
});

test('dates: numeric dates «12.10», «08.10», «12.10.2026»; not decimals, versions, prices or a US «10.12.26»', () => {
  assert.deepEqual(parse('старт 12.10, фінал 08.10 і 12.10.2026').map((m) => m.date), ['2026-10-12', '2026-10-08', '2026-10-12']);
  for (const t of ['Python 3.10 вийшов', 'ціна $0.10 за мільйон', 'Get an Edge on your health. 10.12.26', 'індекс 48.57', '1,05 трлн', 'v0.2.1 (15.95)']) {
    assert.deepEqual(parse(t).filter((m) => m.kind === 'date'), [], t);
  }
});

test('dates: relative words resolve from the publish day in the resource zone', () => {
  const words = parse('позавчора, вчора, сьогодні, завтра, післязавтра');
  assert.deepEqual(words.map((m) => [m.text, m.offset, m.date]), [
    ['позавчора', -2, '2026-10-06'], ['вчора', -1, '2026-10-07'], ['сьогодні', 0, '2026-10-08'], ['завтра', 1, '2026-10-09'], ['післязавтра', 2, '2026-10-10'],
  ]);
  assert.deepEqual(parse('назавтра, завтрашній'), [], 'other words are not the relative words');
  const [z] = parse('тариф Go — з завтра');
  assert.deepEqual([z.kind, z.date, z.preposition], ['relative', '2026-10-09', 'from']);
});

test('dates: weekdays in every case', () => {
  const cases: Array<[string, number]> = [
    ['у понеділок', 1], ['до понеділка', 1], ['по понеділку', 1], ['понеділком', 1],
    ['у вівторок', 2], ['до вівторка', 2], ['вівторком', 2],
    ['середа', 3], ['до середи', 3], ['у середу', 3], ['по середі', 3], ['середою', 3],
    ['четвер', 4], ['до четверга', 4], ['по четвергу', 4], ['четвергом', 4],
    ['пʼятниця', 5], ['до п\'ятниці', 5], ['у п’ятницю', 5], ['пʼятницею', 5],
    ['субота', 6], ['до суботи', 6], ['у суботу', 6], ['суботою', 6],
    ['неділя', 0], ['до неділі', 0], ['у неділю', 0], ['неділею', 0],
  ];
  for (const [t, w] of cases) {
    const ms = parse(t).filter((m) => m.kind === 'weekday');
    assert.equal(ms.length, 1, t);
    assert.equal(ms[0].weekday, w, t);
    assert.equal(ms[0].date, undefined, 'a weekday alone names no day');
  }
  assert.deepEqual(parse('по середах і в середовищі'), [], 'plural (a habit) and other words');
});

test('dates: adjacent mentions share a group («вже завтра, 12 жовтня», «у вівторок, 13 жовтня»), a sentence break splits them', () => {
  const g = parse('Реліз очікується вже завтра, 12 жовтня.');
  assert.deepEqual(g.map((m) => [m.kind, m.group]), [['relative', 0], ['date', 0]]);
  const w = parse('Apple у вівторок, 13 жовтня, представить хаб.');
  assert.deepEqual(w.map((m) => [m.kind, m.group]), [['weekday', 0], ['date', 0]]);
  const apart = parse('Анонс завтра. 12 жовтня буде реліз.');
  assert.notEqual(apart[0].group, apart[1].group);
});

test('dates: «до 15 жовтня 17:00» is a deadline with a time; «з 16 жовтня» a start; «о 16:00 за Києвом» a Kyiv time', () => {
  const d = parse('Безкоштовно до 15 жовтня 17:00.').find((m) => m.kind === 'date')!;
  assert.deepEqual([d.date, d.time, d.zone, d.preposition], ['2026-10-15', '17:00', KYIV, 'until']);
  assert.equal(mentionInstant(d)!.toISOString(), '2026-10-15T14:00:00.000Z', 'Kyiv is UTC+3 before 25.10');

  const f = parse('продажі з 16 жовтня').find((m) => m.kind === 'date')!;
  assert.deepEqual([f.date, f.preposition], ['2026-10-16', 'from']);

  const k = parse('захід 13 жовтня о 16:00 за Києвом у Нью-Йорку');
  const day = k.find((m) => m.kind === 'date')!;
  const time = k.find((m) => m.kind === 'time')!;
  assert.deepEqual([day.date, day.time, day.zone], ['2026-10-13', '16:00', KYIV]);
  assert.deepEqual([time.time, time.zone, time.date], ['16:00', KYIV, '2026-10-13']);

  const pt = parse('до 15 жовтня 10:00 PT').find((m) => m.kind === 'date')!;
  assert.equal(pt.zone, undefined, 'another zone: no instant');
  assert.equal(mentionInstant(pt), null);

  const g = parse('Обидві безкоштовні до завтра, 8 жовтня, 15:00.', { publishedAt: '2026-10-07T12:30:00Z', timezone: KYIV });
  const dl = g.find((m) => m.kind === 'date')!;
  assert.deepEqual([dl.date, dl.time, dl.preposition], ['2026-10-08', '15:00', 'until']);
  assert.equal(g.find((m) => m.kind === 'relative')!.date, '2026-10-08');
});

test('dates: history is not a mention or is marked historical', () => {
  assert.deepEqual(parse('у листопаді 2024 року компанія вже пробувала'), []);
  const [h] = parse('8 жовтня 2024 року компанія вже пробувала');
  assert.deepEqual([h.date, h.historical], ['2024-10-08', true]);
  const [n] = parse('08.10.2025');
  assert.equal(n.historical, true);
});

test('dates: IANA zone around the DST end on 25.10.2026 (Kyiv UTC+3 → UTC+2)', () => {
  // 24.10 21:30Z is 25.10 00:30 in Kyiv (still UTC+3): a fixed +2 offset would say 24.10.
  const before = parse('сьогодні і завтра', { publishedAt: '2026-10-24T21:30:00Z', timezone: KYIV });
  assert.deepEqual(before.map((m) => m.date), ['2026-10-25', '2026-10-26']);
  // 25.10 21:30Z is 25.10 23:30 in Kyiv (now UTC+2): a fixed +3 offset would say 26.10.
  const after = parse('сьогодні і завтра', { publishedAt: '2026-10-25T21:30:00Z', timezone: KYIV });
  assert.deepEqual(after.map((m) => m.date), ['2026-10-25', '2026-10-26']);
  assert.equal(mentionInstant({ date: '2026-10-24', time: '12:00', zone: KYIV })!.toISOString(), '2026-10-24T09:00:00.000Z');
  assert.equal(mentionInstant({ date: '2026-10-25', time: '12:00', zone: KYIV })!.toISOString(), '2026-10-25T10:00:00.000Z');
  assert.equal(formatLocalStamp('2026-10-25T21:30:00Z', KYIV), 'неділя, 25.10.2026 23:30 (Europe/Kyiv)');
  assert.equal(formatLocalStamp('2026-10-08T11:00:00Z', KYIV), 'четвер, 08.10.2026 14:00 (Europe/Kyiv)');
  // Another zone resolves its own day.
  assert.equal(parse('завтра', { publishedAt: '2026-10-08T03:00:00Z', timezone: 'America/New_York' })[0].date, '2026-10-08');
});

test('dates: source dates from URLs and pages; ages with day precision', () => {
  assert.equal(dateFromUrl('https://blog.playstation.com/2026/10/05/everything-you-need/'), '2026-10-05');
  assert.equal(dateFromUrl('https://www.marktechpost.com/2026/10/10/sakana-ai/'), '2026-10-10');
  assert.equal(dateFromUrl('https://www.theverge.com/tech/1008918/google-fitbit-edge'), null);
  assert.equal(dateFromUrl('https://example.com/2026/10/'), null, 'month only');
  assert.equal(dateFromUrl('not a url'), null);
  assert.equal(normalizePublishedAt('2026-10-07T09:12:00-04:00'), '2026-10-07T13:12:00.000Z');
  assert.equal(normalizePublishedAt('Wed, 07 Oct 2026 13:12:00 GMT'), '2026-10-07T13:12:00.000Z');
  assert.equal(normalizePublishedAt('2026-10-07'), '2026-10-07');
  assert.equal(normalizePublishedAt('yesterday'), null);
  assert.equal(sourceAgeHours('2026-10-07T13:00:00Z', '2026-10-08T13:00:00Z'), 24);
  assert.equal(sourceAgeHours('2026-10-07', '2026-10-08T12:00:00Z'), 24, 'a day counts from its noon UTC');
  assert.equal(sourceAgeHours(null, '2026-10-08T12:00:00Z'), null);
});
