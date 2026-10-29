import { isCycle, isSequential } from '../../../data/data-rounds';
import type { PostRequires } from '../../../data/post-requires';
import type { Series } from '../../network/playbook';
import type { Finding } from '../../sysadmin/audit.types';
import { RUNWAY_ALERT_DAYS, runwayDays } from '../../tools/catalog-context';
import { mkFinding } from '../finding';
import type { ChannelFacts, DatasetFact } from '../facts.types';
import type { DoctorCheck } from './index';

/**
 * Spec 072 FR-003.2, A4, A21, lead decision L7: the six material codes. What a dataset needs to be posted from, how full its
 * text is, and how long its rows last. 075 replaces `countPostable` (the loader's seam) with `postableCount`; these checks only
 * read `rows`, `notPostable`, `unusedPostable`, `used28` and `seriesPerDay` of the facts.
 */

/** Fill below this share of rows, for a body field a post needs. */
export const LOW_FILL = 0.5;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Active series of this resource that read a dataset. */
export function seriesOnDataset(f: Pick<ChannelFacts, 'series'>, key: string): Series[] {
  return f.series.filter((s) => s.active !== false && s.source?.kind === 'library' && same(s.source.table, key));
}

/**
 * A4: `post_requires` is a list of groups and a row passes when every group has a filled field, so a field is guaranteed only
 * when a whole group is made of body fields (any of them being filled is a body).
 */
export function requiresBody(postRequires: PostRequires | null | undefined, bodyFields: readonly string[]): boolean {
  if (!bodyFields.length) return false;
  return (postRequires ?? []).some((g) => {
    const group = asList(g);
    return group.length > 0 && group.every((name) => bodyFields.includes(name));
  });
}

/** The reading is not in order: `never`, `after_days` and a random round. */
const readsInOrder = (d: DatasetFact) => isSequential(d.reusePolicy);

/** The series wants an order (a ticket, a chapter, a lesson). */
const ORDER_WORDS = /(?<![\p{L}])(?:білет\p{L}*|ticket\p{L}*|розділ\p{L}*|chapter\p{L}*|по\s+черзі|in\s+order|урок\p{L}*|lesson\p{L}*)/iu;

/** Datasets a card source or an active series reads. */
const bound = (f: ChannelFacts) => f.datasets.filter((d) => d.boundBy.length > 0);

export const materialCheck: DoctorCheck = {
  code: 'material_exhausted',
  run(f: ChannelFacts): Finding[] {
    const out: Finding[] = [];

    // dataset_without_series (A21): a card library source that no active series of this resource reads.
    const otherMaterial = f.card.sources.some((s) => s.kind === 'rss' || s.kind === 'url' || s.kind === 'api')
      || f.series.some((s) => s.active !== false && s.source && ['library', 'feed', 'api'].includes(s.source.kind));
    const seen = new Set<string>();
    for (const s of f.card.sources) {
      if (s.kind !== 'library' || seen.has(s.ref.toLowerCase())) continue;
      seen.add(s.ref.toLowerCase());
      if (seriesOnDataset(f, s.ref).length) continue;
      const key = f.datasets.find((d) => same(d.key, s.ref))?.key ?? s.ref;
      out.push(mkFinding(f, {
        code: 'dataset_without_series',
        severity: otherMaterial ? 'warn' : 'error',
        subject: { type: 'channel', id: key, label: key },
        detail: `The card lists the dataset ${key} as a source, but no active series of this channel reads it.${otherMaterial ? '' : ' It is the only material the channel has, so nothing will be posted from it on a schedule.'}`,
        evidence: { dataset: key, only_material: !otherMaterial },
        values: { dataset: key },
      }));
    }

    for (const d of bound(f)) {
      const series = seriesOnDataset(f, d.key);
      const subject = { type: 'channel' as const, id: d.key, label: d.key };
      const values = { dataset: d.key };

      if (!d.postRequires?.length) {
        out.push(mkFinding(f, {
          code: 'dataset_post_requires_missing', severity: 'warn', subject, values,
          detail: `The dataset ${d.key} is in use, but it does not say which fields a row needs before it can be posted. Rows with no text or no link can be picked and then skipped.`,
          evidence: { dataset: d.key, rows: d.rows },
        }));
      }

      // dataset_low_fill (A4): the best fill of a body field is under half and no group of post_requires guarantees one.
      const bodyFields = asList(d.roles.body);
      if (d.fillRate && bodyFields.length) {
        const best = Math.max(...bodyFields.map((name) => d.fillRate![name] ?? 0));
        if (best < LOW_FILL && !requiresBody(d.postRequires, bodyFields)) {
          const required = series.some((s) => s.source_mode === 'required');
          out.push(mkFinding(f, {
            code: 'dataset_low_fill', severity: required ? 'error' : 'warn', subject, values,
            detail: `Only ${Math.round(best * 100)}% of the rows of ${d.key} have text in ${bodyFields.join(' / ')}, and "post requires" does not ask for it, so most rows picked have nothing to post.`,
            evidence: { dataset: d.key, body_fields: bodyFields, fill: Math.round(best * 1000) / 1000, post_requires: d.postRequires, required_series: required },
          }));
        }
      }

      // material_exhausted / material_low: a cycle dataset rolls its round, so only its postable rows count.
      const postable = d.rows - d.notPostable;
      const exhausted = isCycle(d.reusePolicy) ? postable <= 0 : d.unusedPostable <= 0;
      if (exhausted) {
        out.push(mkFinding(f, {
          code: 'material_exhausted', severity: 'error', subject, values,
          detail: isCycle(d.reusePolicy)
            ? `The dataset ${d.key} repeats in rounds, but none of its ${d.rows} rows can be posted.`
            : `Every postable row of ${d.key} has been used on this channel (${d.rows} rows, ${d.notPostable} cannot be posted).`,
          evidence: { dataset: d.key, rows: d.rows, not_postable: d.notPostable, unused_postable: d.unusedPostable, reuse: d.reusePolicy },
        }));
        continue;
      }
      const days = runwayDays(isCycle(d.reusePolicy) ? postable : d.unusedPostable, d.seriesPerDay, d.used28);
      if (days !== null && days < RUNWAY_ALERT_DAYS) {
        out.push(mkFinding(f, {
          code: 'material_low', severity: 'warn', subject, values,
          detail: `About ${days} days of ${d.key} are left at the current pace (${isCycle(d.reusePolicy) ? postable : d.unusedPostable} rows, ${Math.round(Math.max(d.seriesPerDay, d.used28 / 28) * 10) / 10} a day).`,
          evidence: { dataset: d.key, runway_days: days, unused_postable: d.unusedPostable, postable, series_per_day: d.seriesPerDay, used28: d.used28 },
        }));
      }

      // dataset_order_random: a series that needs an order reads a dataset that does not keep one.
      if (!readsInOrder(d)) {
        for (const s of series) {
          if (!ORDER_WORDS.test(`${s.name} ${s.brief}`)) continue;
          out.push(mkFinding(f, {
            code: 'dataset_order_random', severity: 'info',
            subject: { type: 'channel', id: `${d.key}|${s.name}`, label: `${d.key} / ${s.name}` }, values,
            detail: `Series «${s.name}» looks like it needs an order, but ${d.key} is read ${isCycle(d.reusePolicy) ? 'in random order' : 'at random, each row once'}.`,
            evidence: { dataset: d.key, series: s.name, reuse: d.reusePolicy },
          }));
        }
      }
    }
    return out;
  },
};
