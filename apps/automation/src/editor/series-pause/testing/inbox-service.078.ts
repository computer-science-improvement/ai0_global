/**
 * Spec 078 D5 test support: an `AgentsService` over fakes with the Inbox note, the pauses and the inbox the three unit test
 * files (`inbox-view`, `inbox-actions`, `inbox-unread-pause`) share. Not a test itself.
 */
import { AgentsService } from '../../agents/agents.service';
import { actionViews, pausedActions } from '../note-actions';

export const ID = '3f2b8c1e-7a41-4d52-9b6e-0c1d2e3f4a5b';
export const RULE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

export const noteItem = (o: Record<string, unknown> = {}) => ({
  id: 41, agentId: null, kind: 'series_paused', title: 'Paused', body: null, refType: 'series_pause', refId: ID, severity: 'action', readAt: null,
  createdAt: new Date(), subject: null, parts: null, actions: actionViews(pausedActions(ID)), ...o,
});

export function service(o: { note?: any; pauses?: boolean; agent?: any } = {}) {
  const calls: string[] = [];
  let note = o.note === undefined ? noteItem() : o.note;
  const agent = o.agent ?? { id: 'a1', parentId: null, scope: 'resource', scopeId: 'telegram:@c1', handle: 'c1', kind: 'orchestrator' };
  const inbox = {
    get: async (id: number) => (note && note.id === id ? note : null),
    markUnread: async (ids: number[]) => { calls.push(`unread:${ids}`); return ids.length; },
    markRead: async () => 0, list: async () => [],
  } as any;
  const pauses = o.pauses === false ? undefined : {
    list: async () => [],
    resume: async () => ({ outcome: 'ok', changed: true, code: 'resumed' as const, pause: null }),
    pause: async (t: any, noteId?: number | null, via?: string) => { calls.push(`pause:${t.channelKey}:${t.seriesKey}:${t.label}:${noteId}:${via}`); return calls.some((c) => c === 'taken') ? { outcome: 'x', changed: false, code: 'already_paused' as const } : { outcome: 'ok', changed: true, code: 'paused' as const }; },
    execute: async (id: number, key: string, via?: string) => {
      calls.push(`execute:${id}:${key}:${via}`);
      note = { ...note, readAt: new Date() };
      return { outcome: '✅ Відновлено: Prompt', changed: true, code: 'resumed' as const };
    },
  };
  const svc = new AgentsService({
    pool: { query: async () => ({ rows: [] }) } as any,
    agents: { getByHandle: async (h: string) => (h === 'c1' ? agent : null), get: async () => null } as any,
    skills: {} as any, inbox, setChannelMode: async () => undefined, runNow: async () => ({ started: false, what: '' }), memory: async () => [],
    pauses,
  });
  return { svc, calls };
}

export const status = (e: any) => e.getStatus?.();
