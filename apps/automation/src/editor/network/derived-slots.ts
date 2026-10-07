import type { Pool } from 'pg';
import { parseResourceRef, Platform } from '../agents/agent.types';
import { capabilitiesSummary } from '../platform/capabilities';
import { PlatformPostSpecSchema, type PlatformPostSpec } from '../platform/platform-spec';
import { PostSpecSchema, type PostSpec } from '../post/post-spec';
import { DerivedTreatment, derivedFormatProblem, duplicateSpec, SourcePost, sourceMediaOf } from '../post/duplicate';
import type { EditorSlot } from '../repo/editor-plans.repository';

/**
 * Spec 024 FR-007: executing a derived (duplicate / adapt) slot. The source
 * is resolved here; the runner then gives the agent one short formatting run
 * (duplicate) or a native rewrite (adapt). There is no code-only mirror path.
 */

/** Why a derived slot does not run (stored as the slot's error). */
export type DerivedSkipCode =
  | 'source_failed' | 'source_not_published' | 'source_missing' | 'source_media_gone' | 'resource_left_network' | 'unsupported_format';

export type DerivedResolution =
  | { kind: 'wait' }
  | { kind: 'skip'; code: DerivedSkipCode; details?: string }
  | {
      kind: 'ready';
      treatment:    DerivedTreatment;
      source:       SourcePost;
      /** Resource the source went out on (`telegram:@x`, `instagram:<id>`). */
      sourceRef:    string;
      /** The source is a shadow preview → the derived post is shadowed too. */
      shadow:       boolean;
      /** Held hosted slides of the source (MediaHolds), reused as media. */
      slideUrls:    string[];
      formatNotes:  string | null;
      /** The source slot id (media holds are released after this run). */
      sourceSlotId: string | null;
    };

const TELEGRAM_FORMATS = new Set(['text', 'photo', 'album', 'carousel', 'poll', 'quiz', 'longread', 'video']);

export const DERIVED_FAILED_SOURCE = new Set(['failed', 'skipped', 'expired']);
export const DERIVED_PENDING_SOURCE = new Set(['planned', 'running', 'awaiting_approval', 'approved']);

export interface DerivedSlotsDeps {
  pool:  Pick<Pool, 'query'>;
  /** Hosted slides still held for a source slot. */
  heldUrls?: (slotId: string) => Promise<string[]>;
  /** Refs of the anchor's network right now (null when unknown — membership is not checked then). */
  networkRefs?: (channelKey: string) => Promise<string[] | null>;
}

/** The resource a slot posts to: its resource_ref, or the anchor channel itself. */
export const slotResource = (s: Pick<EditorSlot, 'resourceRef' | 'channelKey'>): string => s.resourceRef ?? `telegram:${s.channelKey}`;

function parseSource(platform: Platform, raw: unknown): SourcePost | null {
  if (!raw || typeof raw !== 'object') return null;
  if (platform === 'telegram') {
    const p = PostSpecSchema.safeParse(raw);
    return p.success ? { platform: 'telegram', spec: p.data } : null;
  }
  const p = PlatformPostSpecSchema.safeParse(raw);
  return p.success ? { platform, spec: p.data } : null;
}

export class DerivedSlots {
  constructor(private readonly d: DerivedSlotsDeps) {}

  /** Decide what a claimed derived slot does now. */
  async resolve(slot: EditorSlot): Promise<DerivedResolution> {
    const treatment = slot.treatment as DerivedTreatment;
    const target = slotResource(slot);
    if (this.d.networkRefs) {
      const refs = await this.d.networkRefs(slot.channelKey).catch(() => null);
      if (refs && !refs.includes(target)) return { kind: 'skip', code: 'resource_left_network' };
    }
    const notes = slot.sourcePost?.format_notes ?? null;
    if (!slot.derivedFromSlotId) {
      if (slot.sourcePost?.key && !slot.sourcePost.key.startsWith('slot:')) return this.resolveExternal(slot, treatment, notes);
      return { kind: 'skip', code: 'source_missing' };
    }
    const { rows } = await this.d.pool.query(`SELECT * FROM editor_slots WHERE id = $1`, [slot.derivedFromSlotId]);
    const src = rows[0];
    if (!src) return { kind: 'skip', code: 'source_missing' };
    if (DERIVED_PENDING_SOURCE.has(src.status)) return { kind: 'wait' };
    if (DERIVED_FAILED_SOURCE.has(src.status)) return { kind: 'skip', code: 'source_failed', details: `source ${src.status}` };
    const sourceRef = src.resource_ref ?? `telegram:${src.channel_key}`;
    const platform = parseResourceRef(sourceRef)?.platform;
    if (!platform) return { kind: 'skip', code: 'source_missing' };
    let source = parseSource(platform, src.post_spec);
    if (!source && platform !== 'telegram') {
      const pp = await this.d.pool.query(`SELECT spec FROM platform_posts WHERE slot_id = $1 ORDER BY id DESC LIMIT 1`, [src.id]);
      source = parseSource(platform, pp.rows[0]?.spec);
    }
    if (!source) return { kind: 'skip', code: 'source_missing', details: 'the source post has no stored spec' };
    const slideUrls = this.d.heldUrls ? await this.d.heldUrls(src.id).catch(() => []) : [];
    const media = sourceMediaOf(source);
    const problem = this.targetProblem(source, slot, treatment, { ...media, images: media.images + slideUrls.length });
    if (problem) return problem;
    return { kind: 'ready', treatment, source, sourceRef, shadow: src.status === 'shadowed', slideUrls, formatNotes: notes, sourceSlotId: src.id };
  }

  /**
   * Non-slot sources of repurpose_post (FR-008/FR-009): a platform post or a
   * published Telegram post without an editor slot — e.g. a strategy post.
   * A strategy post has no stored spec: its title and source become the
   * draft, and its hosted media are gone (carousel slides are deleted after
   * the strategy's own fan-out) → `source_media_gone` when the target needs media.
   */
  protected async resolveExternal(slot: EditorSlot, t: DerivedTreatment, notes: string | null): Promise<DerivedResolution> {
    const key = slot.sourcePost?.key ?? '';
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (kind === 'pp' && /^\d+$/.test(id)) {
      const { rows } = await this.d.pool.query(`SELECT * FROM platform_posts WHERE id = $1`, [Number(id)]);
      const r = rows[0];
      if (!r) return { kind: 'skip', code: 'source_missing' };
      if (r.status === 'failed' || r.status === 'canceled') return { kind: 'skip', code: 'source_failed', details: `source ${r.status}` };
      if (r.status === 'awaiting_approval') return { kind: 'wait' };
      const source = parseSource(r.platform, r.spec);
      if (!source) return { kind: 'skip', code: 'source_missing' };
      const problem = this.targetProblem(source, slot, t, sourceMediaOf(source));
      if (problem) return problem;
      return { kind: 'ready', treatment: t, source, sourceRef: r.resource_ref, shadow: r.status === 'shadowed', slideUrls: [], formatNotes: notes, sourceSlotId: null };
    }
    if (kind === 'tg' && /^\d+$/.test(id)) {
      const { rows } = await this.d.pool.query(`SELECT * FROM published_posts WHERE id = $1`, [Number(id)]);
      const r = rows[0];
      if (!r) return { kind: 'skip', code: 'source_missing' };
      const format = r.format && r.format !== 'legacy' && TELEGRAM_FORMATS.has(r.format) ? r.format : 'text';
      const spec = PostSpecSchema.safeParse({
        format: 'text', title: String(r.title ?? 'Пост').slice(0, 120).padEnd(3, '.'), origin: r.source_url ? 'external' : 'original',
        body: r.title ? [{ type: 'p', text: String(r.title).slice(0, 1500) }] : [], hashtags: (r.tags ?? []).slice(0, 10),
        ...(r.source_url && /^https?:\/\//.test(r.source_url) ? { source: { url: r.source_url } } : {}),
      });
      if (!spec.success) return { kind: 'skip', code: 'source_missing' };
      const source: SourcePost = { platform: 'telegram', spec: { ...spec.data, format } };
      // The text is not stored and the media are gone: a target that needs media cannot be filled.
      const problem = this.targetProblem(source, slot, t, { images: 0, videos: 0, slides: 0 });
      if (problem) return problem.kind === 'skip' && problem.code === 'unsupported_format' ? problem : { kind: 'skip', code: 'source_media_gone', details: (problem as any).details };
      return { kind: 'ready', treatment: t, source, sourceRef: `telegram:${r.channel_id}`, shadow: false, slideUrls: [], formatNotes: notes, sourceSlotId: null };
    }
    return { kind: 'skip', code: 'source_missing' };
  }

  /** Re-check the target format against the source's real media (hard limits only). */
  protected targetProblem(source: SourcePost, slot: EditorSlot, t: DerivedTreatment, media: { images: number; videos: number; slides: number }): DerivedResolution | null {
    const target = parseResourceRef(slotResource(slot));
    if (!target) return { kind: 'skip', code: 'source_missing' };
    const src = { platform: source.platform, format: source.spec.format };
    const tgt = { platform: target.platform, format: slot.format };
    // Impossible by format → unsupported_format; possible by format but the real media are missing → source_media_gone.
    const byFormat = derivedFormatProblem(src, tgt, t);
    if (byFormat) return { kind: 'skip', code: 'unsupported_format', details: byFormat };
    const byMedia = derivedFormatProblem(src, tgt, t, media);
    return byMedia ? { kind: 'skip', code: 'source_media_gone', details: byMedia } : null;
  }
}

/** Steps of the formatting run of a duplicate (short) and of an adapt (a native rewrite). */
export const DERIVED_STEPS: Record<DerivedTreatment, number> = { duplicate: 6, adapt: 14 };

const SOURCE_CHARS = 6_000;

/**
 * The formatting run's prompt (FR-007, FR-013): the source post, the
 * starting draft, the target's profile with its format_prefs, the agent's own
 * format notes and the platform hard limits. Agent prompts stay Ukrainian.
 */
export function derivedPrompts(o: {
  slot: EditorSlot; ready: Extract<DerivedResolution, { kind: 'ready' }>; targetRef: string; targetPlatform: Platform;
  profile: string | null; formatPrefs: string | null; playbook: string | null; memory: string; mode: 'shadow' | 'approve' | 'live';
  skill?: string | null; ownerPrefs?: string[];
}): { system: string; user: string } {
  const { ready, slot } = o;
  const draft = ready.treatment === 'duplicate'
    ? duplicateSpec(ready.source, { platform: o.targetPlatform, format: slot.format }, { slideUrls: ready.slideUrls, ideaId: slot.ideaId ?? null })
    : null;
  const tg = o.targetPlatform === 'telegram';
  const system = [
    ready.treatment === 'duplicate'
      ? `Ти оформлюєш ДУБЛЬ уже опублікованого поста для ${o.targetRef}. Зміст, факти й медіа — ті самі, що в джерелі; подачу вирішуєш ти: розмітка й абзаци, емодзі, довжина й скорочення, хештеги, згадки, заклик, де стоїть посилання (у тексті, «посилання в біо», перший коментар, кнопка), порядок медіа, обкладинка, alt-тексти й тип поста (одне фото, карусель, альбом), якщо медіа дозволяють.`
      : `Ти АДАПТУЄШ пост для ${o.targetRef}: та сама ідея й ті самі факти, але текст і структура — нативні для цієї платформи. Нових фактів не додаєш, лише з джерела (можеш перечитати його джерела).`,
    'Чернетка нижче — лише стартова точка від коду, не готовий результат. Налаштування форматування ресурсу (format_prefs) і твої нотатки мають пріоритет над чернеткою; жорсткі ліміти платформи — понад усе.',
    tg
      ? 'Порядок: lint_post → publish_post (PostSpec). Якщо дубль тут недоречний — skip_slot з причиною.'
      : 'Порядок: lint_platform_post → publish_platform_post (PlatformPostSpec). Якщо дубль тут недоречний — skip_slot з причиною.',
    'Якщо публікація повернула lint_failed — виправ саме ці коди один раз; друга помилка завершить слот як failed.',
    '',
    '## Жорсткі ліміти платформи',
    tg ? '- Telegram: розмітка, кнопки й альбоми — за PostSpec; lint_post покаже порушення.' : capabilitiesSummary([o.targetPlatform]),
    ...(o.profile ? ['', '## Профіль ресурсу', o.profile] : []),
    '',
    '## Форматування ресурсу (format_prefs)',
    o.formatPrefs || '- не задано: на твій розсуд, за нормами платформи',
    ...(ready.formatNotes ? ['', '## Твої нотатки оформлення для цього ресурсу', ready.formatNotes] : []),
    ...(o.playbook ? ['', '## Плейбук для цього ресурсу', o.playbook] : []),
    '',
    '## Памʼять мережі',
    o.memory || '- (порожня)',
    ...(o.ownerPrefs?.length ? ['', ...o.ownerPrefs] : []),
    ...(o.skill ? ['', o.skill] : []),
  ].join('\n');
  const source = JSON.stringify(ready.source.spec, null, 1);
  const user = [
    `Слот ${slot.id} на ${slot.scheduledAt.toISOString()} → ${o.targetRef}, формат ${slot.format} (${ready.treatment}).`,
    slot.treatmentReason ? `Чому так вирішено: ${slot.treatmentReason}` : '',
    `Джерело (${ready.sourceRef}, ${ready.source.spec.format}):`,
    source.length > SOURCE_CHARS ? `${source.slice(0, SOURCE_CHARS)}…` : source,
    ready.slideUrls.length ? `Слайди джерела вже розміщені: ${ready.slideUrls.join(' ')}` : '',
    ...(draft ? ['Чернетка від коду (стартова точка):', JSON.stringify(draft, null, 1)] : []),
    o.mode === 'shadow' ? 'Режим shadow: пост збережеться як превʼю, нічого не публікується.' : '',
    o.mode === 'approve' ? 'Режим апруву: пост чекатиме схвалення власника.' : '',
  ].filter(Boolean).join('\n');
  return { system, user };
}

/** Parse a stored platform spec (exported for tests). */
export function asPlatformSpec(raw: unknown): PlatformPostSpec | null {
  const p = PlatformPostSpecSchema.safeParse(raw);
  return p.success ? p.data : null;
}

/** Parse a stored Telegram spec (exported for tests). */
export function asPostSpec(raw: unknown): PostSpec | null {
  const p = PostSpecSchema.safeParse(raw);
  return p.success ? p.data : null;
}
