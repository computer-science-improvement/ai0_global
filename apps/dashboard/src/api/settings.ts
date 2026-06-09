import { api } from './client';
import type { AppSettings, SettingsPatch } from './types';

// App settings mirror (server .env + DB overrides). The Telegram "Tracking"
// block is editable: PATCH persists overrides to the DB (they win over .env).
export const settingsApi = {
  get: () => api<AppSettings>('/settings'),
  update: (patch: SettingsPatch) =>
    api<AppSettings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
};
