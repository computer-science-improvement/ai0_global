import { api } from './client';
import type { AppSettings, SettingsPatch } from './types';

// App settings. Spec 039: the Configuration tab edits every setting that moved out of .env (the catalog); the old
// `/settings` GET / PATCH (the Tracking block) stays for compatibility.
export type SettingType = 'bool' | 'int' | 'number' | 'string' | 'enum' | 'list' | 'url' | 'cron' | 'secret';
export type SettingSource = 'db' | 'env' | 'default';

export interface SettingState {
  key:            string;
  group:          string;
  label:          string;
  help:           string;
  type:           SettingType;
  apply:          'live' | 'restart';
  default:        string;
  min?:           number;
  max?:           number;
  options?:       string[];
  bool?:          { on: string; off: string };
  danger?:        boolean;
  /** The effective value; null for secrets and when unset. */
  value:          string | null;
  set:            boolean;
  source:         SettingSource;
  updatedAt:      string | null;
  pendingRestart: boolean;
  /** `.env` had a different value at start (ignored); '•' for a secret. */
  envValue:       string | null;
  decryptFailed:  boolean;
}

export interface SettingsCatalog {
  groups:           Array<{ id: string; label: string }>;
  settings:         SettingState[];
  encryptionReady:  boolean;
  restartSupported: boolean;
  bootedAt:         string | null;
  overlayApplied:   boolean;
  overlayError:     string | null;
  pendingRestart:   string[];
}

const enc = encodeURIComponent;

export const settingsApi = {
  get: () => api<AppSettings>('/settings'),
  update: (patch: SettingsPatch) =>
    api<AppSettings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  catalog: () => api<SettingsCatalog>('/settings/catalog'),
  setValue: (key: string, value: string) =>
    api<SettingState>(`/settings/values/${enc(key)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  reset: (key: string) => api<SettingState>(`/settings/values/${enc(key)}`, { method: 'DELETE' }),
  importEnv: (key: string) => api<SettingState>(`/settings/values/${enc(key)}/import-env`, { method: 'POST' }),
  restart: () => api<{ restarting: true }>('/settings/restart', { method: 'POST' }),
};
