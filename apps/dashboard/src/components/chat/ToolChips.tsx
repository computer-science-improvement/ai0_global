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
    <div className="tool-chips">
      <div className="tool-chip-row">
        {items.map((t) => {
          const running = t.ok === undefined;
          const hint = argLine(t.args);
          return (
            <button key={t.id} type="button" onClick={() => setOpen(open === t.id ? null : t.id)}
              className={`tool-chip${t.ok === false ? ' is-failed' : ''}`} aria-expanded={open === t.id}
              title={hint || t.name}>
              <Icon name={ICON[t.name] ?? 'wrench'} size={12} />
              <span className="mono">{t.name}</span>
              {hint && <span className="tool-chip-arg">{hint}</span>}
              <span role="img" aria-label={running ? 'running' : t.ok ? 'done' : 'failed'}>{running ? '…' : t.ok ? '✓' : '✗'}</span>
            </button>
          );
        })}
      </div>
      {sel && (
        <pre className="code-block tool-detail">
          {`${sel.name}(${JSON.stringify(sel.args, null, 1)})\n→ ${sel.ok === undefined ? 'running…' : sel.summary ?? ''}`}
        </pre>
      )}
    </div>
  );
}
