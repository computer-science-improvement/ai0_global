import { z } from 'zod';
import { channelOf, defineTool, type EditorTool, type ToolContext } from '../harness/tool';
import { chatExtras, NEEDS_CHANGE_REQUEST, proposeCard } from '../agents/builder-tools';
import type { PendingActionsService } from '../agents/pending-actions';
import type { ArtifactsService } from './artifacts.service';
import { ARTIFACT_TYPES, artifactRef, parseArtifactRef, type ArtifactRow, type ArtifactType } from './artifact.types';

/** Spec 048 FR-002: the owner card of an agent's change to a live artifact. */
export const UPDATE_ARTIFACT_KIND = 'update_artifact';

export interface UpdateArtifactPayload {
  type:    ArtifactType;
  id:      string;
  patch:   unknown;
  reason:  string;
  agentId: string | null;
  title:   string;
}

export interface ArtifactToolDeps {
  /** Resolved lazily: the registry is built after the tool registry (they depend on each other through the agents). */
  artifacts: () => Pick<ArtifactsService, 'list' | 'find' | 'check' | 'edit'> | undefined;
  actions:   Pick<PendingActionsService, 'propose'>;
}

const BODY_MAX = 6000;

/** What a patch looks like per type (the model reads it in the tool description). */
const PATCHES = [
  'steering: {"rules":[{"id":"s2","enabled":false},{"id":"s3","text":"…"}],"add":[{"kind":"hook","text":"…"}],"remove":["s4"]}',
  'rules: {"add":["…"],"edit":[{"id":123,"text":"…"}],"retire":[124]}',
  'memory: {"retire":[125]}',
  'skill: {"body":"…","description":"…","appliesTo":["executor"]}',
  'playbook: {"body":{…},"rationale":"…"}',
  'profile / formatting: поля, які змінюються (зливаються з поточними)',
].join('; ');

const agentOf = (ctx: ToolContext): { id: string; handle: string } | null => {
  const a = ctx.extras?.agent as { id?: string; handle?: string } | undefined;
  return a?.id && a.handle ? { id: a.id, handle: a.handle } : null;
};

/** A bare type takes the chat's channel or agent; types keyed by uuid need the id. */
function defaultId(type: ArtifactType, ctx: ToolContext): string | null {
  const channel = channelOf(ctx);
  if (type === 'rules' || type === 'memory') return channel;
  if (type === 'profile' || type === 'formatting') return channel ? `telegram:${channel}` : null;
  if (type === 'playbook') return agentOf(ctx)?.id ?? null;
  return null;
}

const compact = (r: ArtifactRow) => ({
  ref: artifactRef(r.type, r.id), title: r.title, status: r.status, version: r.version, live: r.live, summary: r.summary, updated_at: r.updatedAt,
});

function clip(body: unknown): unknown {
  const json = JSON.stringify(body ?? null);
  return json.length <= BODY_MAX ? body : { truncated: true, json: `${json.slice(0, BODY_MAX)}…` };
}

/** get_artifact and update_artifact (spec 048 FR-002): read what shapes the agent; change it through the type's rules. */
export function buildArtifactTools(d: ArtifactToolDeps): EditorTool[] {
  const svcOf = () => {
    const s = d.artifacts();
    if (!s) throw new Error('artifacts are not ready');
    return s;
  };

  const resolve = (ref: string, ctx: ToolContext): { type: ArtifactType; id: string } | { error: string; details: string } => {
    const p = parseArtifactRef(ref.trim());
    if (!p) return { error: 'invalid_ref', details: `type:id, де type — ${ARTIFACT_TYPES.join(', ')}` };
    const id = p.id ?? defaultId(p.type, ctx);
    if (!id) return { error: 'needs_id', details: `для ${p.type} потрібен id: виклич get_artifact без ref і візьми ref зі списку` };
    return { type: p.type, id };
  };

  const getArtifact = defineTool({
    name: 'get_artifact',
    description: [
      'Артефакти, що формують агента: setup (налаштування з історії), steering (правила-напрям з референсу), rules (правила власника), memory (вивчене з рецензій), skill, playbook, profile, formatting.',
      'Без ref — список артефактів агента / каналу (ref, статус, версія, live). З ref (type:id; rules / memory / playbook / profile / formatting можна без id — твій канал) — повний вміст і версії.',
    ].join(' '),
    kind: 'read', roles: ['composer', 'builder', 'orchestrator', 'manager'],
    input: z.object({
      ref:  z.string().trim().min(3).max(120).optional().describe('type:id, напр. steering:<uuid>, rules:@my_channel або просто rules'),
      type: z.enum(ARTIFACT_TYPES).optional().describe('Для списку: лише цей тип'),
    }),
    execute: async (i, ctx) => {
      const svc = svcOf();
      if (!i.ref) {
        const agent = agentOf(ctx);
        const channel = channelOf(ctx);
        const query = agent && agent.handle !== 'ai0' && agent.handle !== 'manager' ? { agent: agent.handle } : channel ? { channel } : {};
        const { rows } = await svc.list({ ...query, ...(i.type ? { type: i.type } : {}), limit: 40 });
        return { artifacts: rows.map(compact), ...(rows.length ? {} : { note: 'немає артефактів для цього агента / каналу' }) };
      }
      const r = resolve(i.ref, ctx);
      if ('error' in r) return r;
      const found = await svc.find(r.type, r.id);
      if (!found) return { error: 'artifact_not_found', details: artifactRef(r.type, r.id) };
      return {
        ...compact(found.row), body: clip(found.body),
        versions: found.versions.slice(0, 10).map((v) => ({ version: v.version, author: v.author, reason: v.reason, at: v.createdAt })),
      };
    },
  });

  const updateArtifact = defineTool({
    name: 'update_artifact',
    description: [
      'Змінити артефакт через його власні правила (ті самі перевірки, що й у власника).',
      'Live-артефакт (діє на пости зараз) і правила власника — лише карткою Apply / Discard: зміна станеться після кліку власника. Чернетка (steering ready / paused, playbook без активної версії) змінюється одразу, якщо власник просив зміну.',
      `Формат patch за типом: ${PATCHES}. Setup змінює лише власник.`,
    ].join(' '),
    kind: 'act', roles: ['composer', 'builder', 'orchestrator', 'manager'], chatOnly: true,
    input: z.object({
      ref:    z.string().trim().min(3).max(120).describe('type:id з get_artifact'),
      patch:  z.record(z.string(), z.unknown()).describe('Зміна у форматі свого типу'),
      reason: z.string().trim().min(5).max(300).describe('Чому — словами власника або з даних'),
    }),
    execute: async (i, ctx) => {
      const x = chatExtras(ctx);
      const svc = svcOf();
      const r = resolve(i.ref, ctx);
      if ('error' in r) return r;
      const found = await svc.find(r.type, r.id);
      if (!found) return { error: 'artifact_not_found', details: artifactRef(r.type, r.id) };
      const checked = await svc.check(r.type, r.id, i.patch);
      if (!checked.ok) return { error: checked.error, details: checked.details };
      const agent = agentOf(ctx);
      // Owner rules are the owner's words: an agent never writes them without the owner's click, even the first one.
      if (found.row.live || r.type === 'rules') {
        const payload: UpdateArtifactPayload = { type: r.type, id: r.id, patch: i.patch, reason: i.reason, agentId: agent?.id ?? null, title: found.row.title };
        return proposeCard(d, ctx, UPDATE_ARTIFACT_KIND, payload as unknown as Record<string, unknown>, `Change ${found.row.title}: ${i.reason}`, agent?.id ?? null);
      }
      if (!x.agentIntent) return NEEDS_CHANGE_REQUEST;
      const done = await svc.edit(r.type, r.id, i.patch, { author: 'agent', agentId: agent?.id ?? null, reason: i.reason });
      if (!done.ok) return { error: done.error, details: done.details };
      return { ok: true, ref: artifactRef(r.type, r.id), version: done.detail.row.version, status: done.detail.row.status, note: 'чернетку змінено; власник бачить нову версію в артефакті' };
    },
  });

  return [getArtifact, updateArtifact];
}

/** The Apply of an update_artifact card: the change as the agent proposed it, checked again now. */
export async function applyUpdateArtifact(svc: Pick<ArtifactsService, 'edit'> | undefined, raw: Record<string, unknown>) {
  if (!svc) throw new Error('artifacts_not_ready: try again in a minute');
  const p = raw as unknown as UpdateArtifactPayload;
  if (!p?.type || !p.id) throw new Error('invalid_card: the card has no artifact');
  const r = await svc.edit(p.type, p.id, p.patch, { author: 'agent', agentId: p.agentId ?? null, reason: `${p.reason} (applied by the owner)` });
  if (!r.ok) throw new Error(`${r.error}: ${typeof r.details === 'string' ? r.details : JSON.stringify(r.details ?? '')}`);
  return { ref: artifactRef(p.type, p.id), version: r.detail.row.version, status: r.detail.row.status };
}
