import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type LandingPlatform = 'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok' | 'youtube';
export interface LandingResource {
  platform: LandingPlatform;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  followerCount: number | null;
  url: string | null;
  order: number;
}
export interface LandingAdminResource extends LandingResource { id: string; landingVisible: boolean; }

// ── Spec 026: public page config (FR-002), DM link preview (FR-003), live pulse (FR-004) ──

export type LandingPlacement = 'hero' | 'topbar' | 'network' | 'resource' | 'mediakit' | 'advertise' | 'footer' | 'howitworks';
export type LandingNetworkPlacement = 'hero' | 'topbar' | 'advertise' | 'footer' | 'howitworks';

/** GET /api/landing/config (public). The links are ready to use: the page has no template logic. */
export interface LandingPublicConfig {
  defaultLang: 'en';
  adDm: { available: boolean; username: string | null; urls: Partial<Record<LandingNetworkPlacement, string>> };
  whiteLabelEnabled: boolean;
}

export type DmUsernameSource = 'setting' | 'agent_session';

export interface LandingAdminConfig {
  settings: { adTgUsername: string | null; adMessage: string | null; whiteLabelEnabled: boolean };
  defaults: { adMessage: string };
  resolved: { username: string | null; source: DmUsernameSource | null };
  agentSessionUsername: string | null;
}

export interface LandingConfigIssue { path: 'adTgUsername' | 'adMessage' | 'whiteLabelEnabled'; message: string }

export interface LandingDmPreview {
  valid: boolean;
  issues: LandingConfigIssue[];
  username: string | null;
  source: DmUsernameSource | null;
  max: number;
  samples: Array<{ placement: LandingPlacement; label: string; target: string | null; message: string; length: number; url: string | null }>;
}

export interface LandingConfigPatch { adTgUsername?: string | null; adMessage?: string | null; whiteLabelEnabled?: boolean }

export type PulsePlatform = LandingPlatform;

// ── Spec 026 FR-006/FR-007: the showcase grouped by network ──

/** live: an AI agent runs it (approval mode included); shadow: the agent trains, the classic pipeline publishes; none: pipeline only. */
export type AiRun = 'live' | 'shadow' | 'none';

export interface LandingNetworkAgent { name: string; emoji: string | null; mode: 'live' | 'shadow' }

export interface LandingNetworkResource extends LandingResource {
  aiRun: AiRun;
  /** "Ads here" Telegram link; set only when the channel has an active ad price. */
  adDmUrl: string | null;
}

/** GET /api/landing/networks (public, cached 300 s). The last group (name null) holds standalone resources. */
export interface LandingNetwork {
  name: string | null;
  blurb: string | null;
  order: number;
  agent: LandingNetworkAgent | null;
  followers: number | null;
  platforms: LandingPlatform[];
  adDmUrl: string | null;
  resources: LandingNetworkResource[];
}

/** GET /api/landing/admin/networks: every network with its landing fields, plus the exact public payload. */
export interface LandingAdminNetwork {
  id: string; name: string; blurb: string | null; order: number;
  resources: number; featured: number; agent: LandingNetworkAgent | null;
}
export interface LandingAdminNetworks { networks: LandingAdminNetwork[]; preview: LandingNetwork[] }
export interface LandingNetworkPatch { blurb?: string | null; order?: number }

/** GET /api/landing/pulse (public; 503 when unavailable — hide the strip then). Aggregates only. */
export interface LandingPulse {
  agents: { orchestratorsLive: number; orchestratorsShadow: number; rolesActive: string[]; manager: 'off' | 'shadow' | 'live' };
  last7d: {
    agentPosts: number; allPosts: number; autonomyShare: number;
    platforms: Array<{ platform: PulsePlatform; posts: number; agentPosts: number }>;
    agentRuns: number; skippedByAgents: number; directivesFiled: number; managerReviews: number;
    ideasReviewed: number; ownerDecisions: number;
  };
  lastAgentPostAt: string | null;
  claims: { managerLive: boolean };
  generatedAt: string;
  stale: boolean;
}

export const landingApi = {
  resources: () => api<LandingResource[]>('/api/landing/resources'),
  adminList: () => api<LandingAdminResource[]>('/api/landing/admin'),
  setFeatured: (platform: LandingPlatform, id: string, body: { landingVisible: boolean; landingOrder: number }) =>
    api<{ ok: true }>(`/api/landing/admin/${platform}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  publicConfig: () => api<LandingPublicConfig>('/api/landing/config'),
  pulse: () => api<LandingPulse>('/api/landing/pulse'),
  networks: () => api<LandingNetwork[]>('/api/landing/networks'),
  adminNetworks: () => api<LandingAdminNetworks>('/api/landing/admin/networks'),
  patchNetwork: (groupId: string, patch: LandingNetworkPatch) =>
    api<{ ok: true }>(`/api/landing/admin/network/${encodeURIComponent(groupId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  adminConfig: () => api<LandingAdminConfig>('/api/landing/admin/config'),
  saveConfig: (patch: LandingConfigPatch) =>
    api<LandingAdminConfig>('/api/landing/admin/config', { method: 'PUT', body: JSON.stringify(patch) }),
  previewConfig: (draft: { adTgUsername: string; adMessage: string }) =>
    api<LandingDmPreview>('/api/landing/admin/config/preview', { method: 'POST', body: JSON.stringify(draft) }),
};

export function useLandingPublicConfig() {
  return useQuery({ queryKey: ['landing', 'config'], queryFn: landingApi.publicConfig, staleTime: 300_000 });
}

/** The proof strip hides on an error (503), so no retries and no error toast. */
export function useLandingPulse() {
  return useQuery({ queryKey: ['landing', 'pulse'], queryFn: landingApi.pulse, staleTime: 300_000, retry: false });
}

export function useLandingNetworks() {
  return useQuery({ queryKey: ['landing', 'networks'], queryFn: landingApi.networks, staleTime: 300_000 });
}

export function useLandingAdminNetworks() {
  return useQuery({ queryKey: ['landing', 'admin', 'networks'], queryFn: landingApi.adminNetworks });
}

export function usePatchLandingNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, patch }: { groupId: string; patch: LandingNetworkPatch }) => landingApi.patchNetwork(groupId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['landing', 'admin', 'networks'] });
      qc.invalidateQueries({ queryKey: ['landing', 'networks'] });
    },
  });
}

export function useLandingAdminConfig() {
  return useQuery({ queryKey: ['landing', 'admin', 'config'], queryFn: landingApi.adminConfig });
}

export function useSaveLandingConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: landingApi.saveConfig,
    onSuccess: (data) => {
      qc.setQueryData(['landing', 'admin', 'config'], data);
      qc.invalidateQueries({ queryKey: ['landing', 'config'] });
    },
  });
}

/** Live preview of a draft; the caller debounces the draft. */
export function useLandingDmPreview(draft: { adTgUsername: string; adMessage: string } | null) {
  return useQuery({
    queryKey: ['landing', 'admin', 'preview', draft],
    queryFn: () => landingApi.previewConfig(draft!),
    enabled: draft !== null,
    placeholderData: keepPreviousData,
  });
}

export function useLandingResources() {
  return useQuery({ queryKey: ['landing', 'resources'], queryFn: landingApi.resources });
}

export function useLandingAdmin() {
  return useQuery({ queryKey: ['landing', 'admin'], queryFn: landingApi.adminList });
}

export function useSetFeatured() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ platform, id, landingVisible, landingOrder }:
      { platform: LandingPlatform; id: string; landingVisible: boolean; landingOrder: number }) =>
      landingApi.setFeatured(platform, id, { landingVisible, landingOrder }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['landing', 'admin'] });
      qc.invalidateQueries({ queryKey: ['landing', 'resources'] });
      qc.invalidateQueries({ queryKey: ['landing', 'networks'] });
    },
  });
}
