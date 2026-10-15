// "Style sheet" block of the Edit formatting modal (spec 037 FR-008): the
// resource's address form, glossary, names, headline, numbers, units,
// audience level, content kind and hashtags (Off / Vocabulary). Only the owner
// edits it; empty fields take the defaults (formal "vy", the default glossary,
// hashtags off on news and games resources). The bootstrap proposal reads the
// last 60 days of posts and changes nothing until the owner accepts it.

import { useState, type CSSProperties } from 'react';
import { Field } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { describeError } from '../ui/Toast';
import { SegmentedTabs } from '../SegmentedTabs';
import { ChipInput } from './ResourceProfile';
import { useStyleProposal, type FormatResource } from '../../api/agents';
import {
  acceptProposal, ADDRESS_LABEL, AUDIENCE_LEVEL_LABEL, NAMES_LABEL, proposalSummary, STYLE_KIND_LABEL, type StyleForm,
} from '../../lib/style-sheet';

const input: CSSProperties = { width: '100%', boxSizing: 'border-box' };
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', columnGap: 14 };
const muted: CSSProperties = { color: 'var(--color-ink-muted)' };

export function StyleSheetEditor({ resource, form, onChange, vocabulary, onVocabulary }: {
  resource: FormatResource; form: StyleForm; onChange: (f: StyleForm) => void;
  /** Telegram only (null elsewhere): the card's hashtag vocabulary, saved to the card. */
  vocabulary: string[] | null; onVocabulary: (v: string[]) => void;
}) {
  const [asked, setAsked] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const proposal = useStyleProposal(resource.ref, asked);
  const eff = resource.style?.effective;
  const set = <K extends keyof StyleForm>(k: K, v: StyleForm[K]) => onChange({ ...form, [k]: v });
  const setGlossary = (g: Pick<StyleForm, 'ban' | 'prefer'>) => onChange({ ...form, ...g, glossaryOwn: true });
  const hashtags = form.hashtags || eff?.hashtags || 'vocabulary';
  const kind = resource.style?.kind;
  const p = proposal.data;
  const pSummary = p ? proposalSummary(p) : '';

  const accept = () => {
    if (!p) return;
    onChange(acceptProposal(form, p));
    if (p.propose.vocabulary && vocabulary) onVocabulary(p.propose.vocabulary);
    setDismissed(true);
  };

  return (
    <section className="panel" aria-labelledby="style-sheet-title" style={{ padding: 12, margin: '4px 0 14px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <Icon name="book" size={14} />
        <strong id="style-sheet-title" className="text-body-sm">Style sheet</strong>
        <span className="text-micro" style={muted}>only you can change it</span>
      </div>
      <p className="text-micro" style={{ ...muted, margin: '0 0 10px' }}>
        The writer and the critic follow it and the checks enforce it. Empty = the default: formal "vy", the default glossary,
        no hashtags on news and games resources.
      </p>

      <div className="panel" style={{ padding: '8px 10px', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {!asked && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="text-micro" style={{ ...muted, flex: '1 1 200px' }}>Suggest names and hashtags from the last 60 days of posts. Nothing changes until you accept.</span>
            <button type="button" className="btn-secondary" onClick={() => { setAsked(true); setDismissed(false); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="sparkles" size={14} /> Suggest
            </button>
          </div>
        )}
        {asked && proposal.isLoading && <span className="text-micro" style={muted}>Reading recent posts…</span>}
        {asked && proposal.error && <span className="text-micro" style={{ color: 'var(--color-danger)' }}>{describeError(proposal.error)}</span>}
        {asked && p && (dismissed || !pSummary) && (
          <span className="text-micro" style={muted}>{dismissed ? 'Proposal closed.' : `Nothing to suggest from ${p.posts} posts of the last ${p.days} days.`}</span>
        )}
        {asked && p && pSummary && !dismissed && (
          <>
            <span className="text-body-sm" style={{ overflowWrap: 'anywhere' }}>{pSummary}</span>
            {(p.names.examples.latin.length > 0 || p.names.examples.cyrillic.length > 0) && (
              <span className="text-micro" style={{ ...muted, overflowWrap: 'anywhere' }}>
                Names seen: {[...p.names.examples.latin, ...p.names.examples.cyrillic].join(', ')}
              </span>
            )}
            {p.propose.vocabulary && (
              <span className="text-micro" style={{ ...muted, overflowWrap: 'anywhere' }}>
                Hashtags: {p.propose.vocabulary.map((t) => `#${t}`).join(' ')}
                {!vocabulary && ' (this resource has no vocabulary to save them to)'}
              </span>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn-primary" onClick={accept}>Accept</button>
              <button type="button" className="btn-secondary" onClick={() => setDismissed(true)}>Reject</button>
            </div>
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Accepting fills the form; save to apply.</span>
          </>
        )}
      </div>

      <div style={grid}>
        <Field label="Address" hint="how posts speak to the reader">
          <select className="input-field" style={input} value={form.address} onChange={(e) => set('address', e.target.value as StyleForm['address'])}>
            <option value="">Default: {ADDRESS_LABEL.vy.toLowerCase()}</option>
            {(Object.keys(ADDRESS_LABEL) as Array<keyof typeof ADDRESS_LABEL>).map((k) => <option key={k} value={k}>{ADDRESS_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="People's names">
          <select className="input-field" style={input} value={form.names} onChange={(e) => set('names', e.target.value as StyleForm['names'])}>
            <option value="">No rule</option>
            {(Object.keys(NAMES_LABEL) as Array<keyof typeof NAMES_LABEL>).map((k) => <option key={k} value={k}>{NAMES_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="Headline max" hint="characters, 40–400">
          <input className="input-field" style={input} type="number" min={40} max={400} value={form.headlineMax} placeholder="No limit"
            onChange={(e) => set('headlineMax', e.target.value)} />
        </Field>
        <Field label="Decimal separator">
          <select className="input-field" style={input} value={form.decimal} onChange={(e) => set('decimal', e.target.value as StyleForm['decimal'])}>
            <option value="">No rule</option><option value="comma">Comma (3,5)</option><option value="dot">Dot (3.5)</option>
          </select>
        </Field>
        <Field label="Units" hint="billions, millions">
          <select className="input-field" style={input} value={form.units} onChange={(e) => set('units', e.target.value as StyleForm['units'])}>
            <option value="">No rule</option><option value="words">In words</option><option value="latin">Latin letters (3B)</option>
          </select>
        </Field>
        <Field label="Audience level" hint="sets the jargon budget">
          <select className="input-field" style={input} value={form.audience} onChange={(e) => set('audience', e.target.value as StyleForm['audience'])}>
            <option value="">No rule</option>
            {(Object.keys(AUDIENCE_LEVEL_LABEL) as Array<keyof typeof AUDIENCE_LEVEL_LABEL>).map((k) => <option key={k} value={k}>{AUDIENCE_LEVEL_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="Content kind" hint="sets freshness and the hashtag default">
          <select className="input-field" style={input} value={form.contentKind} onChange={(e) => set('contentKind', e.target.value as StyleForm['contentKind'])}>
            <option value="">{kind ? `From the resource: ${STYLE_KIND_LABEL[kind].toLowerCase()}` : 'From the resource'}</option>
            {(Object.keys(STYLE_KIND_LABEL) as Array<keyof typeof STYLE_KIND_LABEL>).map((k) => <option key={k} value={k}>{STYLE_KIND_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="Source freshness" hint="hours; empty = news 36, games 72">
          <input className="input-field" style={input} type="number" min={1} max={1440} value={form.freshnessHours} placeholder="Default"
            onChange={(e) => set('freshnessHours', e.target.value)} />
        </Field>
      </div>

      <Field label="Hashtags" hint={form.hashtags ? 'set by you' : `default for this resource: ${hashtags === 'off' ? 'off' : 'vocabulary'}`}>
        <SegmentedTabs size="sm" value={hashtags} onChange={(v) => set('hashtags', v)}
          options={[{ key: 'off', label: 'Off' }, { key: 'vocabulary', label: 'Vocabulary' }]} />
      </Field>
      {hashtags === 'vocabulary' && vocabulary && (
        <Field label="Hashtag vocabulary" hint="without # · Enter to add · saved to the channel card">
          <ChipInput values={vocabulary} onChange={(v) => onVocabulary(v.map((x) => x.replace(/^#/, '')))} max={50} maxLen={40} placeholder="space" label="hashtag" />
        </Field>
      )}
      {hashtags === 'off' && <p className="text-micro" style={{ ...muted, margin: '-4px 0 10px' }}>Posts carry no hashtags; a post with one is blocked.</p>}

      <Field label="Banned forms" hint={`${form.glossaryOwn ? '' : 'the default glossary · '}Enter to add`}>
        <ChipInput values={form.ban} onChange={(v) => setGlossary({ ban: v, prefer: form.prefer })} max={100} maxLen={60} placeholder="word" label="form" />
      </Field>
      <Field label="Preferred forms" hint={`wrong form → right form · a trailing * matches the rest of a word${form.glossaryOwn ? '' : ' · the default glossary'}`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {form.prefer.map((pair, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
              <input className="input-field" style={{ ...input, flex: 1, minWidth: 0 }} value={pair.insteadOf} maxLength={60} placeholder="Instead of"
                aria-label={`Preferred form ${i + 1}: instead of`}
                onChange={(e) => setGlossary({ ban: form.ban, prefer: form.prefer.map((x, j) => (j === i ? { ...x, insteadOf: e.target.value } : x)) })} />
              <Icon name="chevron-right" size={14} />
              <input className="input-field" style={{ ...input, flex: 1, minWidth: 0 }} value={pair.use} maxLength={80} placeholder="Use"
                aria-label={`Preferred form ${i + 1}: use`}
                onChange={(e) => setGlossary({ ban: form.ban, prefer: form.prefer.map((x, j) => (j === i ? { ...x, use: e.target.value } : x)) })} />
              <button type="button" className="btn-act btn-act-danger" aria-label={`Remove preferred form ${i + 1}`} title="Remove"
                onClick={() => setGlossary({ ban: form.ban, prefer: form.prefer.filter((_, j) => j !== i) })} style={{ flexShrink: 0 }}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn-ghost" disabled={form.prefer.length >= 100}
              onClick={() => setGlossary({ ban: form.ban, prefer: [...form.prefer, { insteadOf: '', use: '' }] })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="plus" size={14} /> Add form
            </button>
          </div>
        </div>
      </Field>
    </section>
  );
}
