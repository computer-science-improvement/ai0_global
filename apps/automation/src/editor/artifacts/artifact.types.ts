/**
 * Spec 048 FR-001: an artifact is a typed thing that shapes an agent. Each type keeps its own table; the registry is a
 * read model with one adapter per type.
 */

export const ARTIFACT_TYPES = ['setup', 'steering', 'rules', 'memory', 'skill', 'playbook', 'profile', 'formatting'] as const;
export type ArtifactType = typeof ARTIFACT_TYPES[number];

/** Types whose versions live in artifact_versions (the others version in their own tables, or not at all). */
export const OWN_VERSION_TYPES = ['setup', 'steering', 'rules'] as const;
export type OwnVersionType = typeof OWN_VERSION_TYPES[number];

export const isArtifactType = (v: unknown): v is ArtifactType => typeof v === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(v);

export type ArtifactAuthor = 'owner' | 'agent' | 'system';

/** A compact row for lists, chips and cards. */
export interface ArtifactRow {
  type:      ArtifactType;
  id:        string;
  title:     string;
  /** The orchestrator that the artifact shapes (handle), when known. */
  agent:     string | null;
  /** The Telegram channel key, when the artifact belongs to one. */
  channel:   string | null;
  /** What it applies to: a resource ref, a channel key, or an agent handle. */
  target:    string | null;
  status:    string;
  version:   number | null;
  updatedAt: string;
  /** One English line: counts, the source, the sections. */
  summary:   string;
  /** A live artifact shapes posts now; an agent's change to it goes through an Apply / Discard card (FR-002). */
  live:      boolean;
}

/** An artifact as a chat message carries it (editor_chat_messages.artifacts, FR-005); the dashboard reads the rest. */
export interface ArtifactChip {
  type:   ArtifactType;
  id:     string;
  title:  string;
  status: string;
}

export interface ArtifactVersionMeta {
  version:   number;
  author:    string;
  reason:    string | null;
  createdAt: string;
}

/** What an artifact allows now; `edit` = PATCH, the others are the type's own endpoints. */
export interface ArtifactAction {
  key:    string;
  label:  string;
  method?: 'POST' | 'PATCH' | 'PUT';
  /** The type's own endpoint for the action (the artifact API links, it does not copy). */
  path?:  string;
  danger?: boolean;
}

export interface ArtifactDetail {
  row:      ArtifactRow;
  body:     unknown;
  versions: ArtifactVersionMeta[];
  actions:  ArtifactAction[];
}

export interface ArtifactFilter {
  type?:    ArtifactType;
  /** Agent handle; resolved to its channel and resource refs. */
  agent?:   string;
  channel?: string;
  status?:  string;
  limit?:   number;
}

/** Who makes a change (owner hand edit, an agent tool, the code). */
export interface ArtifactEditor {
  author:   ArtifactAuthor;
  agentId?: string | null;
  reason?:  string | null;
}

export type EditResult = { ok: true; detail: ArtifactDetail } | { ok: false; error: string; details?: unknown };

/** `type:id` → parts; a bare type (`rules`) gives a null id (the chat's channel fills it). */
export function parseArtifactRef(ref: string): { type: ArtifactType; id: string | null } | null {
  const i = ref.indexOf(':');
  const type = i < 0 ? ref : ref.slice(0, i);
  if (!isArtifactType(type)) return null;
  const id = i < 0 ? '' : ref.slice(i + 1).trim();
  return { type, id: id || null };
}

export const artifactRef = (type: ArtifactType, id: string) => `${type}:${id}`;
