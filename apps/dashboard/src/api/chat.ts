import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../lib/env';
import { ApiError, api, unauthorized } from './client';
import type {
  EditorChat, EditorChatChannel, EditorChatDetail, EditorChatEvent, EditorDraft, EditorDraftStatus,
} from './types';

// Editor chat (spec 010): conversations with the composer agent, drafts and
// their publish / schedule / cancel buttons.
const KEY = ['editor-chat'] as const;

export function useChats() {
  return useQuery({
    queryKey: [...KEY, 'chats'],
    queryFn:  () => api<EditorChat[]>('/api/editor/chats'),
  });
}

export function useChat(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, 'chat', id],
    queryFn:  () => api<EditorChatDetail>(`/api/editor/chats/${id}`),
    enabled:  !!id,
    // Scheduled drafts change status on their own (the dispatcher publishes them): keep them fresh.
    refetchInterval: (q) => (q.state.data?.drafts?.some((d) => d.status === 'scheduled') ? 20_000 : false),
    // A deleted / unknown chat id (stale link) is a 404 — show it, don't retry it.
    retry: (n, err: any) => err?.status !== 404 && n < 2,
  });
}

export function useChatChannels() {
  return useQuery({
    queryKey: [...KEY, 'channels'],
    queryFn:  () => api<EditorChatChannel[]>('/api/editor/chat-channels'),
    staleTime: 5 * 60_000,
  });
}

export function useDrafts(status?: EditorDraftStatus) {
  return useQuery({
    queryKey: [...KEY, 'drafts', status ?? 'all'],
    queryFn:  () => api<EditorDraft[]>(`/api/editor/drafts${status ? `?status=${status}` : ''}`),
    refetchInterval: 30_000,
  });
}

export function useCreateChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<EditorChat>('/api/editor/chats', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'chats'] }),
  });
}

export function useDeleteChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/editor/chats/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Draft buttons. Every action refreshes the chats, the thread and the Scheduled list. */
export function useDraftAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: 'publish' | 'cancel' | 'critic' } | { id: string; action: 'schedule'; at: string }) =>
      api<{ draft: EditorDraft; messageId?: number; warnings?: string[]; local?: string }>(
        `/api/editor/drafts/${v.id}/${v.action}`,
        { method: 'POST', ...(v.action === 'schedule' ? { body: JSON.stringify({ at: v.at }) } : {}) },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useInvalidateChat() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

/**
 * Send one message and read the NDJSON stream (fetch + ReadableStream; the
 * endpoint is a POST, so no EventSource). Resolves when the stream ends;
 * aborting the signal stops reading (the server still finishes and saves the answer).
 */
export async function streamChatMessage(
  chatId: string, body: { text: string; channel?: string | null }, onEvent: (e: EditorChatEvent) => void, signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/editor/chats/${chatId}/messages`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) throw await unauthorized(res);
  if (!res.ok || !res.body) throw new ApiError(res.status, await res.text());

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (line: string) => {
    const t = line.trim();
    if (!t) return;
    try { onEvent(JSON.parse(t) as EditorChatEvent); } catch { /* ignore a malformed line */ }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      flush(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  flush(buf + decoder.decode());
}
