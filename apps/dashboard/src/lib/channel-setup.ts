// Channel setup from history (spec 042): labels and the "now → proposed" rows of the proposal dialog.
// Pure (type-only imports), so node tests can import it.
import type { SetupOverviewRow, SetupPostRef, SetupSection, SetupSections, SetupStatus } from '../api/channel-setup';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

export const SETUP_STATUS: Record<SetupStatus, { label: string; tone: Tone; hint?: string }> = {
  queued:            { label: 'Queued', tone: 'neutral' },
  collecting:        { label: 'Reading posts', tone: 'neutral' },
  analyzing:         { label: 'Analyzing', tone: 'neutral' },
  ready:             { label: 'Ready to review', tone: 'warning' },
  partially_applied: { label: 'Partly applied', tone: 'warning' },
  applied:           { label: 'Applied', tone: 'success' },
  discarded:         { label: 'Discarded', tone: 'neutral' },
  superseded:        { label: 'Superseded', tone: 'neutral', hint: 'A newer analysis replaced it' },
  failed:            { label: 'Failed', tone: 'danger' },
  no_access:         { label: 'No access', tone: 'danger', hint: 'The tracking account cannot read this channel' },
  too_few_posts:     { label: 'Too few posts', tone: 'neutral', hint: 'Fewer than 5 posts to learn from' },
  expired:           { label: 'Expired', tone: 'neutral', hint: 'Closed after a while without an apply' },
};

export const SECTION_LABEL: Record<SetupSection, string> = {
  brief_profile:  'Brief and profile',
  formatting:     'Formatting and style',
  format_mix:     'Format mix',
  series_pillars: 'Series and pillars',
  schedule:       'Schedule',
  examples_voice: 'Examples and voice',
};

export const SECTION_HINT: Record<SetupSection, string> = {
  brief_profile:  'The brief the agent writes from and the channel profile (topic, audience, tone, taboos).',
  formatting:     'Length, emoji, CTA, signature, address and hashtags. Fields you locked are kept.',
  format_mix:     'How often each post format is used.',
  series_pillars: 'Recurring series seen in the posts and the topic pillars. Series you locked are kept.',
  schedule:       'Posts per day, quiet hours and the best hours to post.',
  examples_voice: 'Example posts copied from the channel and the channel-voice skill.',
};

export const isRunning = (s: SetupStatus | null | undefined) => s === 'queued' || s === 'collecting' || s === 'analyzing';
/** Spec 057: a proposal nobody applied closes by itself; its reason says after how many days ("expired: closed after 14 days …"). */
export function expiredText(reason: string | null | undefined): string {
  const days = /closed after (\d+) days?/i.exec(reason ?? '')?.[1];
  return `Closed ${days ? `after ${days} day${days === '1' ? '' : 's'} ` : ''}without an apply. Applied sections stay — analyze again for a fresh proposal.`;
}
export const isReviewable = (s: SetupStatus | null | undefined) => s === 'ready' || s === 'partially_applied';

/** A channel whose agent lacks any part of the setup (card, brief, profile or playbook). */
export function missingSetup(r: SetupOverviewRow): string[] {
  const out: string[] = [];
  if (!r.hasCard) out.push('card');
  if (!r.hasBrief) out.push('brief');
  if (!r.hasProfile) out.push('profile');
  if (!r.hasPlaybook) out.push('playbook');
  return out;
}

export function fmtUsd(v: number): string {
  if (v === 0) return '$0';
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

/** "about $0.40 for 5 channels", or no estimate before the first run. */
export function estimateText(perChannel: number | null, n: number): string {
  const what = `${n} channel${n === 1 ? '' : 's'}`;
  if (perChannel == null) return `${what} (no cost estimate yet: it comes from past runs)`;
  return `${what} (about ${fmtUsd(perChannel * n)})`;
}

const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const list = (xs: unknown[] | undefined | null) => (xs && xs.length ? xs.join(', ') : '—');
/** A value as one readable line: strings as is, lists joined, objects as "key value" pairs (`{target: 300}` → "target 300"). */
const text = (v: unknown): string => {
  if (v == null || v === '') return '—';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(text).join(', ');
  if (typeof v === 'object') return Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => `${k} ${text(x)}`).join(', ');
  return String(v);
};

export interface Row { label: string; value: string }

/** The proposed value of a section as label / value rows. */
export function proposedRows(section: SetupSection, s: SetupSections): Row[] {
  switch (section) {
    case 'brief_profile': {
      const p = s.brief_profile.profile;
      return [
        { label: 'Brief', value: s.brief_profile.brief },
        { label: 'Topic', value: text(p.topic) },
        { label: 'Audience', value: text(p.audience?.who) },
        { label: 'Language', value: text(p.language) },
        { label: 'Goals', value: list(p.goals) },
        { label: 'Tone', value: text(p.tone) },
        { label: 'Taboo', value: list(p.taboo) },
      ];
    }
    case 'formatting': {
      const f = s.formatting;
      const rows: Row[] = Object.entries(f.format_prefs ?? {}).map(([k, v]) => ({ label: k, value: text(v) }));
      if (f.style && Object.keys(f.style).length) rows.push({ label: 'style', value: text(f.style) });
      const c = f.card ?? {};
      if (c.hashtags) rows.push({ label: 'hashtags', value: list(c.hashtags.map((h) => `#${h}`)) });
      if (c.hashtag_min != null || c.hashtag_max != null) rows.push({ label: 'hashtags per post', value: `${c.hashtag_min ?? 0}–${c.hashtag_max ?? '…'}` });
      if (c.footer !== undefined) rows.push({ label: 'footer', value: text(c.footer) });
      if (c.emoji_policy) rows.push({ label: 'emoji policy', value: c.emoji_policy });
      if (c.link_style) rows.push({ label: 'link style', value: c.link_style });
      return rows;
    }
    case 'format_mix':
      return Object.entries(s.format_mix.formats).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: pct(v) }));
    case 'series_pillars':
      return [
        ...s.series_pillars.series.map((x) => ({ label: `Series «${x.name}»`, value: `${x.cadence} · ${x.format} · ${x.brief}` })),
        { label: 'Pillars', value: s.series_pillars.pillars.map((p) => `${p.name} ${p.share}%`).join(' · ') },
      ];
    case 'schedule': {
      const x = s.schedule;
      return [
        { label: 'Posts per day', value: `${x.posts_per_day_min}–${x.posts_per_day_max}` },
        { label: 'Quiet hours', value: `${pad(x.quiet_start_hour)} → ${pad(x.quiet_end_hour)}` },
        { label: 'Best hours', value: x.best_hours.length ? [...x.best_hours].sort((a, b) => a - b).map(pad).join(', ') : '—' },
      ];
    }
    case 'examples_voice': {
      const v = s.examples_voice.voice;
      return [
        { label: 'Example posts', value: list(s.examples_voice.example_ids) },
        { label: 'Voice', value: v.description },
        ...v.rules.map((r, i) => ({ label: `Rule ${i + 1}`, value: r })),
        ...v.quotes.map((q, i) => ({ label: `Quote ${i + 1}`, value: `«${q}»` })),
      ];
    }
  }
}

/** What a section holds now (the server's section baseline) as label / value rows; empty when nothing is set. */
export function currentRows(section: SetupSection, current: Record<string, unknown> | null | undefined): Row[] {
  const c = (current?.[section] ?? null) as any;
  if (!c) return [];
  switch (section) {
    case 'brief_profile': {
      const p = c.profile ?? {};
      return [
        { label: 'Brief', value: text(c.brief) },
        { label: 'Topic', value: text(p.topic) },
        { label: 'Audience', value: text(p.audience?.who) },
        { label: 'Tone', value: text(p.tone) },
      ].filter((r) => r.value !== '—');
    }
    case 'formatting': {
      const rows: Row[] = Object.entries(c.format_prefs ?? {}).filter(([, v]) => v != null).map(([k, v]) => ({ label: k, value: text(v) }));
      if (c.style) rows.push({ label: 'style', value: text(c.style) });
      if (c.card?.hashtags?.length) rows.push({ label: 'hashtags', value: list(c.card.hashtags.map((h: string) => `#${h}`)) });
      if (c.card?.footer) rows.push({ label: 'footer', value: text(c.card.footer) });
      if (c.locks?.length) rows.push({ label: 'locked', value: list(c.locks) });
      return rows;
    }
    case 'format_mix': {
      const f = c.formats as Record<string, number> | null;
      if (!f) return [];
      const sum = Object.values(f).reduce((a, b) => a + b, 0) || 1;
      return Object.entries(f).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: pct(v / sum) }));
    }
    case 'series_pillars':
      return [
        ...(c.series ?? []).map((x: any) => ({ label: `Series «${x.name}»${x.locked ? ' (locked)' : ''}`, value: `${x.cadence} · ${x.format}` })),
        ...(c.pillars?.length ? [{ label: 'Pillars', value: c.pillars.map((p: any) => `${p.name} ${p.share}%`).join(' · ') }] : []),
      ];
    case 'schedule': {
      const rows: Row[] = [];
      if (c.postsPerDayMin != null || c.postsPerDayMax != null) rows.push({ label: 'Posts per day', value: `${c.postsPerDayMin ?? '…'}–${c.postsPerDayMax ?? '…'}` });
      if (c.quietStartHour != null && c.quietEndHour != null) rows.push({ label: 'Quiet hours', value: `${pad(c.quietStartHour)} → ${pad(c.quietEndHour)}` });
      if (c.bestHours?.length) rows.push({ label: 'Best hours', value: c.bestHours.map(pad).join(', ') });
      return rows;
    }
    case 'examples_voice':
      return [
        ...(c.examples?.length ? [{ label: 'Example posts', value: `${c.examples.length} saved` }] : []),
        ...(c.voice ? [{ label: 'Voice skill', value: 'channel-voice is set' }] : []),
      ];
  }
}

/** The posts a section's evidence points to, in the order given (unknown keys are dropped). */
export function evidencePosts(keys: string[] | undefined, posts: SetupPostRef[]): SetupPostRef[] {
  const byKey = new Map(posts.map((p) => [p.key, p]));
  return (keys ?? []).map((k) => byKey.get(k)).filter((p): p is SetupPostRef => !!p);
}

/** The keys a section points to: its evidence plus the section's own post lists (series posts, example posts). */
export function sectionPostKeys(section: SetupSection, s: SetupSections): string[] {
  const own = section === 'series_pillars' ? s.series_pillars.series.flatMap((x) => x.post_ids)
    : section === 'examples_voice' ? s.examples_voice.example_ids : [];
  return [...new Set([...(s[section].evidence?.post_ids ?? []), ...own])];
}
