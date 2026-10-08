// Spec 026 FR-015: the "Public page" card on /app/landing edits a local draft of the
// landing settings; these pure helpers turn the server state into a draft and a draft
// back into the minimal PUT patch (only what changed).
import type { LandingAdminConfig, LandingConfigPatch } from '../api/landing';

export interface LandingConfigDraft {
  username: string;
  message: string;
  whiteLabelEnabled: boolean;
}

/** Same limit as the server (landing-dm.ts AD_TEMPLATE_MAX). */
export const AD_TEMPLATE_MAX = 240;

export function draftFromConfig(cfg: LandingAdminConfig): LandingConfigDraft {
  return {
    username: cfg.settings.adTgUsername ?? '',
    message: cfg.settings.adMessage ?? cfg.defaults.adMessage,
    whiteLabelEnabled: cfg.settings.whiteLabelEnabled,
  };
}

function cleanUsername(v: string): string {
  return v.trim().replace(/^@/, '');
}

/** The fields that differ from the saved state; `{}` when nothing changed. Empty or default values clear a key. */
export function configPatch(cfg: LandingAdminConfig, draft: LandingConfigDraft): LandingConfigPatch {
  const patch: LandingConfigPatch = {};
  const user = cleanUsername(draft.username);
  if (user !== (cfg.settings.adTgUsername ?? '')) patch.adTgUsername = user || null;

  const savedMessage = cfg.settings.adMessage ?? cfg.defaults.adMessage;
  if (draft.message !== savedMessage) {
    patch.adMessage = draft.message.trim() === '' || draft.message === cfg.defaults.adMessage ? null : draft.message;
    if (patch.adMessage === null && cfg.settings.adMessage === null) delete patch.adMessage; // already the default
  }
  if (draft.whiteLabelEnabled !== cfg.settings.whiteLabelEnabled) patch.whiteLabelEnabled = draft.whiteLabelEnabled;
  return patch;
}

/** The body the live preview posts (the server falls back to the agent account and the default text). */
export function previewDraft(draft: LandingConfigDraft): { adTgUsername: string; adMessage: string } {
  return { adTgUsername: cleanUsername(draft.username), adMessage: draft.message };
}

/** Code points, like the server counts them. */
export function charCount(s: string): number {
  return Array.from(s).length;
}
