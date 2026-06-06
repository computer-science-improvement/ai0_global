import { api } from './client';
import type { AppSettings } from './types';

// Read-only app settings mirror (server .env). No mutations — changing these
// means editing .env on the server + restart.
export const settingsApi = {
  get: () => api<AppSettings>('/settings'),
};
