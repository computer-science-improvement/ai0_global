import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import { loadDirectory, type AgentDirectory, type ArtifactAdapter, type ResolvedFilter } from './artifact-adapters';
import {
  ARTIFACT_TYPES, isArtifactType, type ArtifactDetail, type ArtifactEditor, type ArtifactRow, type ArtifactType, type EditResult,
} from './artifact.types';

const ListQuery = z.object({
  type:    z.enum(ARTIFACT_TYPES).optional(),
  agent:   z.string().trim().regex(/^@?[a-z][a-z0-9_]{2,31}$/).optional(),
  channel: z.string().trim().regex(/^@[A-Za-z0-9_]{3,64}$/).optional(),
  status:  z.string().trim().max(40).optional(),
  limit:   z.coerce.number().int().min(1).max(200).default(100),
});

/** Spec 048 FR-001: the artifact registry over the per-type adapters. */
export class ArtifactsService {
  private readonly adapters: Map<ArtifactType, ArtifactAdapter>;

  constructor(private readonly d: { pool: Pick<Pool, 'query'>; adapters: ArtifactAdapter[] }) {
    this.adapters = new Map(d.adapters.map((a) => [a.type, a]));
  }

  private adapter(type: string): ArtifactAdapter {
    const a = isArtifactType(type) ? this.adapters.get(type) : undefined;
    if (!a) throw new NotFoundException({ error: 'unknown_type', details: `artifact types: ${[...this.adapters.keys()].join(', ')}` });
    return a;
  }

  async list(raw: unknown): Promise<{ rows: ArtifactRow[] }> {
    const q = ListQuery.safeParse(raw ?? {});
    if (!q.success) throw new BadRequestException({ error: 'invalid_query', issues: q.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const dir = await loadDirectory(this.d.pool);
    const handle = q.data.agent?.replace(/^@/, '');
    const agent = handle ? dir.byHandle.get(handle) : undefined;
    if (handle && !agent) return { rows: [] };
    const f: ResolvedFilter = {
      channel: q.data.channel ?? agent?.channel ?? undefined, ref: agent?.ref ?? undefined, agentId: agent?.id,
      status: q.data.status, limit: q.data.limit,
    };
    const types = q.data.type ? [q.data.type] : [...this.adapters.keys()];
    const lists = await Promise.all(types.map((t) => this.adapters.get(t)!.list(f, dir).catch(() => [] as ArtifactRow[])));
    const rows = lists.flat()
      .filter((r) => !handle || r.agent === handle)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, q.data.limit);
    return { rows };
  }

  /** The artifact, or null; also records a body that changed elsewhere as a version (own-version types). */
  async find(type: ArtifactType, id: string, dir?: AgentDirectory): Promise<ArtifactDetail | null> {
    const a = this.adapter(type);
    const d = dir ?? await loadDirectory(this.d.pool);
    const got = await a.get(id, d);
    if (!got) return null;
    return { row: got.row, body: got.body, versions: await a.versions(id), actions: a.actions(got.row, got.body) };
  }

  async get(type: string, id: string): Promise<ArtifactDetail & { chatId: string | null }> {
    const a = this.adapter(type);
    const found = await this.find(a.type, id);
    if (!found) throw new NotFoundException({ error: 'artifact_not_found' });
    return { ...found, chatId: await this.chatOf(a.type, id) };
  }

  /** FR-006 "Open in chat": the latest chat whose message made or named the artifact. */
  private async chatOf(type: ArtifactType, id: string): Promise<string | null> {
    const { rows } = await this.d.pool.query(
      `SELECT m.chat_id FROM editor_chat_messages m JOIN editor_chats c ON c.id = m.chat_id
        WHERE m.artifacts @> $1::jsonb ORDER BY m.created_at DESC LIMIT 1`,
      [JSON.stringify([{ type, id }])]).catch(() => ({ rows: [] as any[] }));
    return rows[0]?.chat_id ?? null;
  }

  async version(type: string, id: string, v: number): Promise<{ version: number; body: unknown }> {
    const a = this.adapter(type);
    const body = await a.version(id, v);
    if (body === undefined) throw new NotFoundException({ error: 'version_not_found' });
    return { version: v, body };
  }

  /** A change by the owner (PATCH) or an agent (update_artifact, after its card is applied for a live artifact). */
  async edit(type: ArtifactType, id: string, patch: unknown, by: ArtifactEditor): Promise<EditResult> {
    const a = this.adapter(type);
    if (!a.edit) return { ok: false, error: 'read_only', details: `${type} artifacts are not edited here` };
    const dir = await loadDirectory(this.d.pool);
    if (!(await a.get(id, dir))) return { ok: false, error: 'artifact_not_found' };
    const r = await a.edit(id, patch, by, dir);
    if (!r.ok) return r;
    const detail = await this.find(type, id, dir);
    return detail ? { ok: true, detail } : { ok: false, error: 'artifact_not_found' };
  }

  /** The type's validation of a change without writing it (an agent's card is refused at once). */
  async check(type: ArtifactType, id: string, patch: unknown): Promise<{ ok: true } | { ok: false; error: string; details?: unknown }> {
    const a = this.adapter(type);
    if (!a.edit) return { ok: false, error: 'read_only', details: `${type} artifacts are not edited here` };
    return a.check ? a.check(id, patch) : { ok: true };
  }

  /** PATCH /api/artifacts/:type/:id — the owner's hand edit; refusals answer 400 with the type's reasons. */
  async patch(type: string, id: string, body: unknown): Promise<ArtifactDetail> {
    const a = this.adapter(type);
    const b = z.object({ patch: z.unknown(), reason: z.string().trim().max(300).optional() }).strict().safeParse(body ?? {});
    if (!b.success) throw new BadRequestException({ error: 'invalid_body', details: 'send { patch, reason? }' });
    const r = await this.edit(a.type, id, b.data.patch, { author: 'owner', reason: b.data.reason ?? 'owner edit' });
    if (!r.ok) {
      if (r.error === 'artifact_not_found') throw new NotFoundException({ error: r.error });
      throw new BadRequestException({ error: r.error, details: r.details });
    }
    return r.detail;
  }
}
