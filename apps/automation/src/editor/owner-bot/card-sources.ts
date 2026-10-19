import type { Pool } from 'pg';
import type { CardButton } from './owner-cards.repository';
import { htmlToPlain } from '../post/inline-markup';
import { kyivTime } from './owner-text';

/**
 * Spec 012 FR-002: what waits for the owner, kind by kind. A source lists its waiting items (the sweep makes cards of
 * the new ones and closes the cards whose item stopped waiting) and runs a button through the same service method the
 * dashboard button calls. Outcomes and labels are the owner's Telegram text (Ukrainian).
 */
export interface WaitingItem {
  refId:    string;
  title:    string;
  body:     string | null;
  /** Dashboard path ("/app/…"); the Відкрити button. */
  path:     string | null;
  critical: boolean;
  /** When it started waiting: the backlog rule compares it with `owner_bot.cards_since`. */
  since:    Date;
  buttons:  CardButton[];
}

export interface CardSource {
  kind:  string;
  emoji: string;
  label: string;
  waiting(now: Date): Promise<WaitingItem[]>;
  /** Runs a button; returns the outcome line. Throws when the action is refused (the reason goes on the card). */
  act(refId: string, key: string): Promise<string>;
  /** Of these items that stopped waiting, the ones that expired (their card says "Минув термін"). */
  expired?(refIds: string[]): Promise<Set<string>>;
}

export interface SourceDeps {
  pool:       Pick<Pool, 'query'>;
  approvals:  { approve(id: string): Promise<{ movedTo: Date | null }>; reject(id: string, body: unknown): Promise<unknown> };
  directives: { decide(id: string, approve: boolean): Promise<unknown>; ownerDecision(id: string, d: 'uphold' | 'accept_refusal'): Promise<unknown> };
  actions:    { apply(id: string): Promise<unknown>; discard(id: string): Promise<unknown> };
  steering:   { activate(id: string): Promise<unknown>; discard(id: string): Promise<unknown> };
  setup:      {
    apply(id: string, body: unknown): Promise<{ applied: string[]; failed: { section: string; error: string } | null; changedSinceAnalysis: string[] }>;
    discard(id: string): Promise<unknown>;
  };
  playbooks:  { decide(id: string, approve: boolean): Promise<unknown> };
  inbox:      { markRead(ids: number[]): Promise<number> };
  /** The setup sections "Застосувати все" applies (setup-analysis SETUP_SECTIONS). */
  setupSections: readonly string[];
  /** A post due within this window is a critical card (FR-002: 2 hours). */
  criticalWithinMs?: number;
}

const open = (): CardButton => ({ key: 'open', label: 'Відкрити' });
const ids = (refIds: string[]) => refIds.filter((r) => /^[0-9a-f-]{36}$/i.test(r));
const at = (outcome: string) => `${outcome} · ${kyivTime(new Date())}`;
const handleOf = (h: string | null | undefined) => (h ? `@${h}` : 'агент');

const SECTION_UK: Record<string, string> = {
  brief_profile: 'опис і профіль', formatting: 'форматування', format_mix: 'мікс форматів',
  series_pillars: 'серії й теми', schedule: 'розклад', examples_voice: 'приклади й голос',
};

/** Posts to approve (031), only in batches whose approval alert went out: a batch still being written gets no cards. */
export function approvalSource(d: SourceDeps): CardSource {
  return {
    kind: 'approval', emoji: '📝', label: 'Пост на схвалення',
    async waiting(now) {
      const { rows } = await d.pool.query(
        `SELECT s.id, s.channel_key, s.topic, s.rendered_preview, s.scheduled_at, c.title AS channel_title, a.sent_at
           FROM editor_slots s
           JOIN editor_plans p ON p.id = s.plan_id
           JOIN approval_alerts a ON a.channel_key = s.channel_key AND a.batch_date = p.plan_date
           LEFT JOIN editor_channels c ON c.channel_key = s.channel_key
          WHERE s.status = 'awaiting_approval'
          ORDER BY s.scheduled_at`);
      const soon = now.getTime() + (d.criticalWithinMs ?? 2 * 3_600_000);
      return rows.map((r: any) => ({
        refId: r.id,
        title: `${r.channel_title || r.channel_key} · ${kyivDay(r.scheduled_at)}${r.topic ? ` · ${r.topic}` : ''}`,
        // The preview is Telegram HTML: the card shows it as text (the card escapes it again).
        body: r.rendered_preview ? htmlToPlain(r.rendered_preview) : null,
        path: `/app/editor/slot/${r.id}`,
        critical: new Date(r.scheduled_at).getTime() <= soon,
        since: new Date(r.sent_at),
        buttons: [{ key: 'approve', label: '✅ Опублікувати' }, { key: 'reject', label: '❌ Відхилити' }, open()],
      }));
    },
    async act(id, key) {
      if (key === 'approve') {
        const r = await d.approvals.approve(id);
        return at(r.movedTo ? `✅ Схвалено, вийде о ${kyivTime(r.movedTo)}` : '✅ Схвалено');
      }
      if (key === 'reject') { await d.approvals.reject(id, {}); return at('❌ Відхилено'); }
      throw new Error(`unknown button ${key}`);
    },
    async expired(refIds) {
      const { rows } = await d.pool.query(`SELECT id FROM editor_slots WHERE id = ANY($1::uuid[]) AND status = 'expired'`, [ids(refIds)]);
      return new Set(rows.map((r: any) => r.id));
    },
  };
}

/** Directives the manager filed for the owner (021/025): awaiting_owner, and contested ones (ref `<id>:contested`). */
export function directiveSources(d: SourceDeps): CardSource[] {
  const list = async (status: string) => (await d.pool.query(
    `SELECT dr.id, dr.kind, dr.body, dr.rationale, dr.resolution, dr.created_at, dr.contested_at, a.handle
       FROM agent_directives dr LEFT JOIN agents a ON a.id = dr.to_agent_id
      WHERE dr.status = $1 AND NOT dr.shadow ORDER BY dr.created_at`, [status])).rows;
  const expired = async (refIds: string[]) => {
    const { rows } = await d.pool.query(`SELECT id FROM agent_directives WHERE id = ANY($1::uuid[]) AND status = 'expired'`,
      [ids(refIds.map((r) => r.replace(/:contested$/, '')))]);
    const gone = new Set(rows.map((r: any) => r.id as string));
    return new Set(refIds.filter((r) => gone.has(r.replace(/:contested$/, ''))));
  };
  return [
    {
      kind: 'directive', emoji: '🧭', label: 'Директива',
      async waiting() {
        return (await list('awaiting_owner')).map((r: any) => ({
          refId: r.id, title: `${handleOf(r.handle)} · ${r.kind}`,
          body: [r.body, r.rationale ? `Чому: ${r.rationale}` : null].filter(Boolean).join('\n\n') || null,
          path: '/app/agents/inbox', critical: false, since: new Date(r.created_at),
          buttons: [{ key: 'approve', label: '✅ Схвалити' }, { key: 'decline', label: '❌ Відхилити' }, open()],
        }));
      },
      async act(id, key) {
        if (key !== 'approve' && key !== 'decline') throw new Error(`unknown button ${key}`);
        await d.directives.decide(id, key === 'approve');
        return at(key === 'approve' ? '✅ Схвалено' : '❌ Відхилено');
      },
      expired,
    },
    {
      kind: 'contested', emoji: '⚖️', label: 'Агент заперечує директиву',
      async waiting() {
        return (await list('contested')).map((r: any) => ({
          refId: `${r.id}:contested`, title: `${handleOf(r.handle)} · ${r.kind}`,
          body: [r.body, r.resolution ? `Заперечення: ${r.resolution}` : null].filter(Boolean).join('\n\n') || null,
          path: '/app/agents/inbox', critical: false, since: new Date(r.contested_at ?? r.created_at),
          buttons: [{ key: 'uphold', label: 'Наполягти' }, { key: 'accept_refusal', label: 'Прийняти відмову' }, open()],
        }));
      },
      async act(ref, key) {
        if (key !== 'uphold' && key !== 'accept_refusal') throw new Error(`unknown button ${key}`);
        await d.directives.ownerDecision(ref.replace(/:contested$/, ''), key);
        return at(key === 'uphold' ? 'Наполягли' : 'Відмову прийнято');
      },
      expired,
    },
  ];
}

/** Agent cards (018, 048) made outside a chat; a card in a chat is answered in the chat. */
export const CHOICE_ACTION_KINDS = new Set(['content_examples']);

export function actionSource(d: SourceDeps): CardSource {
  return {
    kind: 'action', emoji: '🃏', label: 'Пропозиція агента',
    async waiting() {
      const { rows } = await d.pool.query(
        `SELECT pa.id, pa.kind, pa.summary, pa.created_at, a.handle
           FROM pending_actions pa LEFT JOIN agents a ON a.id = pa.agent_id
          WHERE pa.status = 'pending' AND pa.chat_id IS NULL ORDER BY pa.created_at`);
      return rows.map((r: any) => ({
        refId: r.id, title: `${handleOf(r.handle)} · ${r.kind}`, body: r.summary ?? null,
        path: '/app/agents/inbox', critical: false, since: new Date(r.created_at),
        buttons: CHOICE_ACTION_KINDS.has(r.kind)
          ? [open()]
          : [{ key: 'apply', label: '✅ Застосувати' }, { key: 'discard', label: 'Відхилити' }, open()],
      }));
    },
    async act(id, key) {
      if (key === 'apply') { await d.actions.apply(id); return at('✅ Застосовано'); }
      if (key === 'discard') { await d.actions.discard(id); return at('Відхилено'); }
      throw new Error(`unknown button ${key}`);
    },
    async expired(refIds) {
      const { rows } = await d.pool.query(`SELECT id FROM pending_actions WHERE id = ANY($1::uuid[]) AND status = 'expired'`, [ids(refIds)]);
      return new Set(rows.map((r: any) => r.id));
    },
  };
}

/** Steering sets (045) ready to activate. */
export function steeringSource(d: SourceDeps): CardSource {
  return {
    kind: 'steering', emoji: '🎯', label: 'Стиль за референсом',
    async waiting() {
      const { rows } = await d.pool.query(
        `SELECT id, channel_key, source_ref, source_title, summary, updated_at FROM steering_sets WHERE status = 'ready' ORDER BY updated_at`);
      return rows.map((r: any) => ({
        refId: r.id, title: `${r.channel_key} ← ${r.source_title || r.source_ref}`, body: r.summary ?? null,
        path: `/app/artifacts?open=steering:${r.id}`, critical: false, since: new Date(r.updated_at),
        buttons: [{ key: 'activate', label: 'Активувати' }, { key: 'discard', label: 'Відхилити' }, open()],
      }));
    },
    async act(id, key) {
      if (key === 'activate') { await d.steering.activate(id); return at('✅ Активовано'); }
      if (key === 'discard') { await d.steering.discard(id); return at('Відхилено'); }
      throw new Error(`unknown button ${key}`);
    },
  };
}

/** Setup from history (042) ready to apply. "Застосувати все" asks to confirm. */
export function setupSource(d: SourceDeps): CardSource {
  return {
    kind: 'setup', emoji: '🛠', label: 'Налаштування з історії',
    async waiting() {
      const { rows } = await d.pool.query(
        `SELECT id, channel_key, updated_at FROM channel_setup_proposals WHERE status = 'ready' ORDER BY updated_at`);
      return rows.map((r: any) => ({
        refId: r.id, title: r.channel_key,
        body: `Пропозиція готова: ${d.setupSections.map((s) => SECTION_UK[s] ?? s).join(', ')}.`,
        path: `/app/artifacts?open=setup:${r.id}`, critical: false, since: new Date(r.updated_at),
        buttons: [
          { key: 'apply_all', label: 'Застосувати все', confirm: 'Так, застосувати все' },
          { key: 'discard', label: 'Відхилити' }, open(),
        ],
      }));
    },
    async act(id, key) {
      if (key === 'discard') { await d.setup.discard(id); return at('Відхилено'); }
      if (key !== 'apply_all') throw new Error(`unknown button ${key}`);
      const r = await d.setup.apply(id, { sections: [...d.setupSections] });
      const parts = [r.applied.length ? `✅ Застосовано: ${r.applied.map((s) => SECTION_UK[s] ?? s).join(', ')}` : 'Нічого не застосовано'];
      if (r.changedSinceAnalysis.length) parts.push(`змінено після аналізу: ${r.changedSinceAnalysis.map((s) => SECTION_UK[s] ?? s).join(', ')}`);
      if (r.failed) parts.push(`помилка в «${SECTION_UK[r.failed.section] ?? r.failed.section}»: ${r.failed.error}`);
      return at(parts.join('; '));
    },
  };
}

/** Playbook versions (020) waiting for the owner. */
export function playbookSource(d: SourceDeps): CardSource {
  return {
    kind: 'playbook', emoji: '📘', label: 'Плейбук',
    async waiting() {
      const { rows } = await d.pool.query(
        `SELECT p.id, p.agent_id, p.version, p.rationale, p.created_at, a.handle
           FROM playbooks p LEFT JOIN agents a ON a.id = p.agent_id
          WHERE p.status = 'pending_owner' ORDER BY p.created_at`);
      return rows.map((r: any) => ({
        refId: r.id, title: `${handleOf(r.handle)} · версія ${r.version}`, body: r.rationale ?? null,
        path: `/app/artifacts?open=playbook:${r.agent_id}`, critical: false, since: new Date(r.created_at),
        buttons: [{ key: 'approve', label: '✅ Схвалити' }, { key: 'reject', label: '❌ Відхилити' }, open()],
      }));
    },
    async act(id, key) {
      if (key !== 'approve' && key !== 'reject') throw new Error(`unknown button ${key}`);
      await d.playbooks.decide(id, key === 'approve');
      return at(key === 'approve' ? '✅ Схвалено' : '❌ Відхилено');
    },
  };
}

/**
 * Inbox notes that need the owner (017, 049): unread, critical or action, and not about an item with a card of its own.
 * The card itself is made when the note is posted (OwnerInbox's card sink keeps the Telegram wording); the sweep uses
 * `waiting` to close the card once the note is read in the dashboard.
 */
export const OWN_CARD_REF_TYPES = ['directive', 'playbook'];

export function inboxSource(d: SourceDeps): CardSource {
  return {
    kind: 'inbox', emoji: '🔔', label: 'Сповіщення',
    async waiting() {
      const { rows } = await d.pool.query(
        `SELECT id, title, body, severity, created_at FROM agent_inbox
          WHERE read_at IS NULL AND severity IN ('critical', 'action')
            AND (ref_type IS NULL OR ref_type <> ALL($1::text[])) ORDER BY created_at`, [OWN_CARD_REF_TYPES]);
      return rows.map((r: any) => inboxItem(Number(r.id), { title: r.title, body: r.body ?? null, severity: r.severity }, new Date(r.created_at)));
    },
    async act(id, key) {
      if (key !== 'read') throw new Error(`unknown button ${key}`);
      await d.inbox.markRead([Number(id)]);
      return at('✓ Прочитано');
    },
  };
}

export function inboxItem(id: number, n: { title: string; body: string | null; severity: string }, since: Date): WaitingItem {
  return {
    refId: String(id), title: n.title, body: n.body, path: '/app/agents/inbox', critical: n.severity === 'critical', since,
    buttons: [{ key: 'read', label: '✓ Прочитано' }, open()],
  };
}

export function cardSources(d: SourceDeps): CardSource[] {
  return [approvalSource(d), ...directiveSources(d), actionSource(d), steeringSource(d), setupSource(d), playbookSource(d), inboxSource(d)];
}

function kyivDay(d: Date | string): string {
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(d));
}
