import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type LandingPlatform = 'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok';
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

export const landingApi = {
  resources: () => api<LandingResource[]>('/api/landing/resources'),
  adminList: () => api<LandingAdminResource[]>('/api/landing/admin'),
  setFeatured: (platform: LandingPlatform, id: string, body: { landingVisible: boolean; landingOrder: number }) =>
    api<{ ok: true }>(`/api/landing/admin/${platform}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
};

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
    },
  });
}
