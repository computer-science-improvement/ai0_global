import { isCycle } from '../../../data/data-rounds';
import type { Finding } from '../../sysadmin/audit.types';
import { mkFinding } from '../finding';
import type { ChannelFacts, DatasetFact, SourceFact } from '../facts.types';
import type { DoctorCheck } from './index';

/**
 * Spec 072 FR-003.5, A12: open pauses. The system pauses a series after a streak of skips (060); the owner may pause one too.
 * A pause whose cause is provably gone is `pause_cause_gone` (warn, one tap to resume); the others are plain information.
 * `source_unreachable` is judged on proof: a block that has passed is not enough, the host must have answered since the pause.
 */

const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const seriesOfKey = (key: string): string | null => (key.startsWith('series:') ? key.slice('series:'.length) : null);
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** The dataset a `no_material` pause is about: the library table of the paused series. */
function datasetOf(f: ChannelFacts, key: string): DatasetFact | null {
  const name = seriesOfKey(key);
  const series = name === null ? undefined : f.series.find((s) => s.name === name);
  if (!series || series.source?.kind !== 'library') return null;
  const table = series.source.table;
  return f.datasets.find((d) => sameKey(d.key, table)) ?? null;
}

/** W1 reads the loader's counts (`countPostable`); 075's `materialAvailable` replaces this at the W2 merge. A cycle dataset rolls, so it counts its postable rows. */
const hasMaterial = (d: DatasetFact) => (isCycle(d.reusePolicy) ? d.rows - d.notPostable > 0 : d.unusedPostable > 0);

/** The source of the paused series, as the facts hold it. */
const sourceOf = (f: ChannelFacts, key: string): SourceFact | null => {
  const name = seriesOfKey(key);
  return name === null ? null : f.sources.find((s) => s.origin === `series:${name}`) ?? null;
};

/**
 * `series_paused` shares its catalogue entry with the slot's skip reason (spec 073), whose link is the Schedule tab; a pause row
 * of the panel links to the Overview, where the pause banner sits, like the other two pause codes.
 */
const PAUSE_LINK = '/app/agents/:agent?tab=overview';

export const pausesCheck: DoctorCheck = {
  code: 'series_paused',
  run(f: ChannelFacts): Finding[] {
    const out: Finding[] = [];
    for (const p of f.pauses) {
      if (p.resumedAt) continue;
      const subject = { type: 'channel' as const, id: p.id, label: p.label };
      const base = { pause_id: p.id, key: p.key, cause: p.cause, streak: p.streak, paused_at: new Date(p.pausedAt).toISOString(), reason: p.reason };

      if (p.cause === 'owner') {
        out.push(mkFinding(f, {
          code: 'series_paused_by_owner', severity: 'info', subject,
          detail: `«${p.label}» has been paused by you since ${day(p.pausedAt)}. It stays paused until you resume it.`,
          evidence: base,
        }));
        continue;
      }

      const resume = { kind: 'series_resume' as const, channel: f.channelKey, pauseId: p.id };
      if (p.cause === 'no_material') {
        const ds = datasetOf(f, p.key);
        if (ds && hasMaterial(ds)) {
          out.push(mkFinding(f, {
            code: 'pause_cause_gone', severity: 'warn', subject, fix: resume,
            detail: `«${p.label}» was paused for lack of material, but ${ds.key} has rows that can be posted again (${isCycle(ds.reusePolicy) ? ds.rows - ds.notPostable : ds.unusedPostable}).`,
            evidence: { ...base, dataset: ds.key, unused_postable: ds.unusedPostable },
          }));
          continue;
        }
        out.push(mkFinding(f, {
          code: 'series_paused', severity: 'info', subject, fix: resume, link: PAUSE_LINK,
          detail: `«${p.label}» has been paused since ${day(p.pausedAt)} after ${p.streak} skipped slots in a row: it had no material to post.`,
          evidence: { ...base, ...(ds ? { dataset: ds.key, unused_postable: ds.unusedPostable } : {}) },
        }));
        continue;
      }

      // source_unreachable: the host must have no block now and must have answered after the pause (lastSuccessAt, null until 076).
      const src = sourceOf(f, p.key);
      const answered = src?.lastSuccessAt ? Date.parse(src.lastSuccessAt) : NaN;
      if (src && src.hostBlock === null && Number.isFinite(answered) && answered > new Date(p.pausedAt).getTime()) {
        out.push(mkFinding(f, {
          code: 'pause_cause_gone', severity: 'warn', subject, fix: resume,
          detail: `«${p.label}» was paused because its source could not be reached, but ${src.host ?? src.url} answered again on ${day(src.lastSuccessAt!)} and nothing blocks it now.`,
          evidence: { ...base, source: src.url, last_success_at: src.lastSuccessAt },
        }));
        continue;
      }
      out.push(mkFinding(f, {
        code: 'series_paused', severity: 'info', subject, link: PAUSE_LINK,
        detail: `«${p.label}» has been paused since ${day(p.pausedAt)} after ${p.streak} skipped slots in a row: its source could not be reached.`,
        evidence: { ...base, ...(src ? { source: src.url, host_block: src.hostBlock } : {}) },
      }));
    }
    return out;
  },
};
