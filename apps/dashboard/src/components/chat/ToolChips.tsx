// Live tool activity of a composer turn as compact chips ("fetch_feed…" →
// "fetch_feed ✓"). Click a chip to see its arguments and the result summary.

import { useState } from 'react';
import { Icon, type IconName } from '../ui/Icon';

export interface ToolActivity {
  id:       number;
  name:     string;
  args:     unknown;
  /** undefined while running. */
  ok?:      boolean;
  summary?: string;
}

const ICON: Record<string, IconName> = {
  fetch_feed: 'discovery', web_fetch: 'globe', extract_images: 'globe', fetch_api: 'globe',
  search_library: 'book', sql_readonly: 'database', get_channel_stats: 'analytics', get_recent_posts: 'analytics',
  get_top_posts: 'analytics', get_channel_memory: 'book', check_similarity: 'refresh', list_skills: 'sparkles',
  load_skill: 'sparkles', get_channel_card: 'channels', lint_post: 'check', preview_post: 'eye',
  list_my_channels: 'channels', save_draft: 'pencil', publish_draft: 'rocket', schedule_draft: 'calendar',
  cancel_draft: 'ban', list_drafts: 'logs',
};

function argLine(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  const v = a.url ?? a.query ?? a.name ?? a.source ?? a.channel ?? a.table ?? a.at ?? a.draft_id;
  return typeof v === 'string' ? v : '';
}

export function ToolChips({ items }: { items: ToolActivity[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!items.length) return null;
  const sel = items.find((t) => t.id === open);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map((t) => {
          const running = t.ok === undefined;
          const color = running ? 'var(--color-ink-muted)' : t.ok ? 'var(--color-ink-muted)' : 'var(--color-danger)';
          const hint = argLine(t.args);
          return (
            <button key={t.id} type="button" onClick={() => setOpen(open === t.id ? null : t.id)}
              title={hint || t.name}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: 280, cursor: 'pointer',
                padding: '3px 9px', borderRadius: 'var(--radius-pill)', fontSize: 11.5, lineHeight: 1.5,
                background: open === t.id ? 'var(--color-surface-3)' : 'var(--color-surface-2)',
                border: '1px solid var(--color-hairline)', color,
              }}>
              <Icon name={ICON[t.name] ?? 'wrench'} size={12} />
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{t.name}</span>
              {hint && <span style={{ color: 'var(--color-ink-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{hint}</span>}
              <span aria-hidden>{running ? '…' : t.ok ? '✓' : '✗'}</span>
            </button>
          );
        })}
      </div>
      {sel && (
        <pre className="text-micro" style={{
          margin: '6px 0 0', padding: 10, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)',
          color: 'var(--color-ink-muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}>
          {`${sel.name}(${JSON.stringify(sel.args, null, 1)})\n→ ${sel.ok === undefined ? 'running…' : sel.summary ?? ''}`}
        </pre>
      )}
    </div>
  );
}
