// Spec 024 FR-013: format_prefs ⇄ the owner's edit form, and short English
// lines for the Formatting section (pure; unit-tested).

import type { FormatPrefField, FormatPrefs } from '../api/agents';

export const FORMAT_LABEL: Record<FormatPrefField, string> = {
  tone: 'Tone', length: 'Length', emoji: 'Emoji', hashtags: 'Hashtags', mentions: 'Mentions', cta: 'Call to action',
  links: 'Links', line_breaks: 'Line breaks', signature: 'Signature', preferred_formats: 'Preferred formats', media: 'Media', notes: 'Notes',
};
const EMOJI = { none: 'none', light: 'light', rich: 'rich' } as const;
const LINKS = { inline: 'in the text', bio: 'link in bio', first_comment: 'first comment', button: 'button' } as const;

/** One field's value as a short English line. */
export function formatValue(k: FormatPrefField, v: unknown): string {
  if (v == null) return '—';
  switch (k) {
    case 'length': { const l = v as { target: number; max: number }; return `~${l.target} chars, max ${l.max}`; }
    case 'emoji': return EMOJI[v as keyof typeof EMOJI] ?? String(v);
    case 'links': return LINKS[v as keyof typeof LINKS] ?? String(v);
    case 'hashtags': {
      const h = v as { count: number; style?: string; fixed?: string[] };
      return [String(h.count), h.style, h.fixed?.length ? `always ${h.fixed.map((x) => `#${x}`).join(' ')}` : ''].filter(Boolean).join(' · ');
    }
    case 'preferred_formats': return (v as string[]).join(', ');
    case 'media': { const m = v as { aspect?: string; cover_style?: string }; return [m.aspect, m.cover_style].filter(Boolean).join(' · ') || '—'; }
    default: return String(v);
  }
}

export interface FormatForm {
  tone: string; lengthTarget: string; lengthMax: string; emoji: '' | 'none' | 'light' | 'rich';
  hashCount: string; hashStyle: string; hashFixed: string[]; mentions: string; cta: string;
  links: '' | 'inline' | 'bio' | 'first_comment' | 'button'; lineBreaks: string; signature: string;
  formats: string[]; aspect: string; cover: string; notes: string;
}

export function toForm(p: FormatPrefs): FormatForm {
  return {
    tone: p.tone ?? '', lengthTarget: p.length ? String(p.length.target) : '', lengthMax: p.length ? String(p.length.max) : '',
    emoji: p.emoji ?? '', hashCount: p.hashtags ? String(p.hashtags.count) : '', hashStyle: p.hashtags?.style ?? '', hashFixed: p.hashtags?.fixed ?? [],
    mentions: p.mentions ?? '', cta: p.cta ?? '', links: p.links ?? '', lineBreaks: p.line_breaks ?? '', signature: p.signature ?? '',
    formats: p.preferred_formats ?? [], aspect: p.media?.aspect ?? '', cover: p.media?.cover_style ?? '', notes: p.notes ?? '',
  };
}

export function toPrefs(f: FormatForm): FormatPrefs {
  const t = (s: string) => s.trim() || undefined;
  const n = (s: string) => (s.trim() === '' ? undefined : Number(s));
  const out: FormatPrefs = {
    tone: t(f.tone), emoji: f.emoji || undefined, mentions: t(f.mentions), cta: t(f.cta), links: f.links || undefined,
    line_breaks: t(f.lineBreaks), signature: t(f.signature), notes: t(f.notes),
    preferred_formats: f.formats.length ? f.formats : undefined,
  };
  if (n(f.lengthTarget) !== undefined || n(f.lengthMax) !== undefined) out.length = { target: n(f.lengthTarget) ?? 0, max: n(f.lengthMax) ?? 0 };
  if (n(f.hashCount) !== undefined || f.hashFixed.length || t(f.hashStyle)) out.hashtags = { count: n(f.hashCount) ?? 0, style: t(f.hashStyle), fixed: f.hashFixed };
  if (t(f.aspect) || t(f.cover)) out.media = { aspect: t(f.aspect), cover_style: t(f.cover) };
  return JSON.parse(JSON.stringify(out)) as FormatPrefs; // drops undefined
}
