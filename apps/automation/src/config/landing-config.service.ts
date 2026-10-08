// apps/automation/src/config/landing-config.service.ts
// Spec 026 FR-002: the landing's owner-editable settings, kept in app_settings
// under `landing.*` (SettingsService skips these keys: they are not env overrides).
//
//   landing.ad_tg_username       the Telegram account that takes ad DMs (optional)
//   landing.ad_message_en        the DM template ({target}, {ref}); default DEFAULT_AD_MESSAGE
//   landing.white_label_enabled  'true' | 'false' (default true)
//
// The landing ships in English only (owner decision 2026-10-06), so there is no
// Ukrainian template and no default-language setting; `defaultLang` is always 'en'.
//
// The DM username resolves: the setting → the username of the active MTProto
// session with role 'agent' → null. With null the page shows only the form CTA.
// The public view is cached for 300 s; an admin save drops the cache.
import { BadRequestException } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  DEFAULT_AD_MESSAGE, NETWORK_PLACEMENTS, buildAdDmUrl, normalizeTgUsername, renderAdMessage,
  buildLandingRef, validateAdTemplate, AD_MESSAGE_MAX,
  type LandingPlacement, type NetworkPlacement,
} from './landing-dm';

export const LANDING_KEYS = {
  adTgUsername:      'landing.ad_tg_username',
  adMessage:         'landing.ad_message_en',
  whiteLabelEnabled: 'landing.white_label_enabled',
} as const;

export type DmUsernameSource = 'setting' | 'agent_session';

export interface LandingPublicConfig {
  defaultLang: 'en';
  adDm: {
    available: boolean;
    username:  string | null;
    /** Ready links for the CTAs whose target is the whole network (the page has no template logic). */
    urls: Partial<Record<NetworkPlacement, string>>;
  };
  whiteLabelEnabled: boolean;
}

export interface LandingAdminConfig {
  /** Stored values (null = not set, the default applies). */
  settings: { adTgUsername: string | null; adMessage: string | null; whiteLabelEnabled: boolean };
  defaults: { adMessage: string };
  /** The account the public CTAs open now, and where it came from. */
  resolved: { username: string | null; source: DmUsernameSource | null };
  /** The verified username of the active agent MTProto session (the fallback), if any. */
  agentSessionUsername: string | null;
}

export interface LandingDmPreviewSample {
  placement: LandingPlacement;
  label:     string;
  target:    string | null;
  message:   string;
  length:    number;
  url:       string | null;
}

/** One validation problem, in the `{path, message}` shape the dashboard's error toasts read. */
export interface LandingConfigIssue { path: 'adTgUsername' | 'adMessage' | 'whiteLabelEnabled'; message: string }

export interface LandingDmPreview {
  valid:    boolean;
  issues:   LandingConfigIssue[];
  username: string | null;
  source:   DmUsernameSource | null;
  max:      number;
  samples:  LandingDmPreviewSample[];
}

export interface LandingConfigPatch {
  adTgUsername?:      string | null;
  adMessage?:         string | null;
  whiteLabelEnabled?: boolean;
}

/** What the DM link builder needs for any placement (T4/T5 reuse this). */
export interface AdDmContext { username: string; template: string }

const PUBLIC_TTL_MS = 300_000;

/** Fixed sample targets for the admin preview (a network CTA, a channel card and a long title). */
const PREVIEW_SAMPLES: Array<{ placement: LandingPlacement; label: string; target: string | null; channelKey?: string }> = [
  { placement: 'hero',     label: 'Hero button (whole network)', target: null },
  { placement: 'resource', label: 'Channel card (example)',      target: 'Space Daily', channelKey: 'space_daily' },
  {
    placement: 'mediakit', label: 'Media kit row, very long title (example)', channelKey: 'long_title_example',
    target: 'A channel with a very long title that keeps going to show how the target is shortened so the message stays within the Telegram prefill limit and the attribution tag survives intact, no matter how long the name of the channel gets in the media kit',
  },
];

type Q = Pick<Pool, 'query'>;

export class LandingConfigService {
  private publicCache: { at: number; value: LandingPublicConfig } | null = null;

  constructor(private readonly pool: Q, private readonly now: () => number = Date.now) {}

  // ── reads ────────────────────────────────────────────────────────────────

  private async readSettings(): Promise<Record<string, string>> {
    const { rows } = await this.pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [Object.values(LANDING_KEYS)]);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** The verified username of the active agent session; null when none (or the table is older). */
  private async agentSessionUsername(): Promise<string | null> {
    try {
      const { rows } = await this.pool.query<{ username: string | null }>(
        `SELECT username FROM mtproto_sessions
          WHERE active AND role = 'agent' AND username IS NOT NULL
          ORDER BY created_at LIMIT 1`);
      return normalizeTgUsername(rows[0]?.username ?? null);
    } catch {
      return null;
    }
  }

  private static resolve(setting: string | null | undefined, session: string | null): { username: string | null; source: DmUsernameSource | null } {
    const fromSetting = normalizeTgUsername(setting ?? null);
    if (fromSetting) return { username: fromSetting, source: 'setting' };
    if (session) return { username: session, source: 'agent_session' };
    return { username: null, source: null };
  }

  private static template(stored: string | null | undefined): string {
    return stored && validateAdTemplate(stored).length === 0 ? stored : DEFAULT_AD_MESSAGE;
  }

  /** Username + template for the DM links, or null when no username resolves. */
  async adDm(): Promise<AdDmContext | null> {
    const s = await this.readSettings();
    const { username } = LandingConfigService.resolve(s[LANDING_KEYS.adTgUsername], await this.agentSessionUsername());
    return username ? { username, template: LandingConfigService.template(s[LANDING_KEYS.adMessage]) } : null;
  }

  /** GET /api/landing/config — cached 300 s. */
  async publicConfig(): Promise<LandingPublicConfig> {
    const t = this.now();
    if (this.publicCache && t - this.publicCache.at < PUBLIC_TTL_MS) return this.publicCache.value;
    const s = await this.readSettings();
    const { username } = LandingConfigService.resolve(s[LANDING_KEYS.adTgUsername], await this.agentSessionUsername());
    const template = LandingConfigService.template(s[LANDING_KEYS.adMessage]);
    const urls: Partial<Record<NetworkPlacement, string>> = {};
    if (username) {
      for (const placement of NETWORK_PLACEMENTS) {
        const url = buildAdDmUrl({ username, template, placement });
        if (url) urls[placement] = url;
      }
    }
    const value: LandingPublicConfig = {
      defaultLang: 'en',
      adDm: { available: username !== null, username, urls },
      whiteLabelEnabled: s[LANDING_KEYS.whiteLabelEnabled] !== 'false',
    };
    this.publicCache = { at: t, value };
    return value;
  }

  /** GET /api/landing/admin/config */
  async adminConfig(): Promise<LandingAdminConfig> {
    const s = await this.readSettings();
    const session = await this.agentSessionUsername();
    return {
      settings: {
        adTgUsername:      s[LANDING_KEYS.adTgUsername] ?? null,
        adMessage:         s[LANDING_KEYS.adMessage] ?? null,
        whiteLabelEnabled: s[LANDING_KEYS.whiteLabelEnabled] !== 'false',
      },
      defaults: { adMessage: DEFAULT_AD_MESSAGE },
      resolved: LandingConfigService.resolve(s[LANDING_KEYS.adTgUsername], session),
      agentSessionUsername: session,
    };
  }

  // ── preview (no writes) ──────────────────────────────────────────────────

  /** POST /api/landing/admin/config/preview — a draft rendered through the same builder as the public page. */
  async preview(draft: { adTgUsername?: unknown; adMessage?: unknown }): Promise<LandingDmPreview> {
    const issues: LandingConfigIssue[] = [];
    const rawUser = typeof draft.adTgUsername === 'string' ? draft.adTgUsername.trim() : '';
    if (rawUser && !normalizeTgUsername(rawUser)) issues.push(usernameIssue(rawUser));
    const rawTemplate = typeof draft.adMessage === 'string' ? draft.adMessage : '';
    const template = rawTemplate.trim() ? rawTemplate : DEFAULT_AD_MESSAGE;
    if (rawTemplate.trim()) issues.push(...templateIssues(rawTemplate));

    const { username, source } = LandingConfigService.resolve(rawUser || null, await this.agentSessionUsername());
    const samples = PREVIEW_SAMPLES.map((s) => {
      const message = renderAdMessage({ template, target: s.target, ref: buildLandingRef(s.placement, s.channelKey) });
      return {
        placement: s.placement,
        label:     s.label,
        target:    s.target,
        message,
        length:    Array.from(message).length,
        url:       username ? buildAdDmUrl({ username, template, target: s.target, placement: s.placement, channelKey: s.channelKey }) : null,
      };
    });
    return { valid: issues.length === 0, issues, username, source, max: AD_MESSAGE_MAX, samples };
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /** PUT /api/landing/admin/config — validates everything first, then writes; null or '' clears a key. */
  async update(patch: LandingConfigPatch): Promise<LandingAdminConfig> {
    const writes: Array<[string, string | null]> = [];
    const issues: LandingConfigIssue[] = [];

    if (patch.adTgUsername !== undefined) {
      const raw = patch.adTgUsername === null ? '' : String(patch.adTgUsername).trim();
      if (!raw) writes.push([LANDING_KEYS.adTgUsername, null]);
      else {
        const u = normalizeTgUsername(raw);
        if (u) writes.push([LANDING_KEYS.adTgUsername, u]);
        else issues.push(usernameIssue(raw));
      }
    }
    if (patch.adMessage !== undefined) {
      const raw = patch.adMessage === null ? '' : String(patch.adMessage);
      if (!raw.trim() || raw === DEFAULT_AD_MESSAGE) writes.push([LANDING_KEYS.adMessage, null]);
      else {
        const v = templateIssues(raw);
        if (v.length === 0) writes.push([LANDING_KEYS.adMessage, raw]);
        else issues.push(...v);
      }
    }
    if (patch.whiteLabelEnabled !== undefined) {
      if (typeof patch.whiteLabelEnabled !== 'boolean') issues.push({ path: 'whiteLabelEnabled', message: 'must be true or false' });
      else writes.push([LANDING_KEYS.whiteLabelEnabled, patch.whiteLabelEnabled ? null : 'false']);
    }
    if (issues.length > 0) throw new BadRequestException({ error: 'invalid_landing_config', issues });

    for (const [key, value] of writes) {
      if (value === null) await this.pool.query(`DELETE FROM app_settings WHERE key = $1`, [key]);
      else {
        await this.pool.query(
          `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, value]);
      }
    }
    this.publicCache = null;
    return this.adminConfig();
  }
}

function usernameIssue(raw: string): LandingConfigIssue {
  return { path: 'adTgUsername', message: `“${raw.slice(0, 40)}” is not a Telegram username: 5–32 letters, digits or _, starting with a letter.` };
}

function templateIssues(template: string): LandingConfigIssue[] {
  return validateAdTemplate(template).map((message) => ({ path: 'adMessage' as const, message }));
}
