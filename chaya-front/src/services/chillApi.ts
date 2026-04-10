import { getBackendUrl } from '../utils/backendUrl';

const authFetch: typeof fetch = (input, init) => {
  const token = localStorage.getItem('chaya_token');
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(input, { ...init, headers });
};

const base = () => `${getBackendUrl()}/api/chill`;

export type ChillVideoItem = {
  kind: 'video';
  videoId: string;
  title: string;
  channelTitle?: string;
  description?: string;
  thumbnailUrl?: string;
  isLive?: boolean;
  liveBroadcastContent?: string;
};

export type ChillChannelItem = {
  kind: 'channel';
  channelId: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
};

export type ChillSearchItem = ChillVideoItem | ChillChannelItem;

export async function fetchChillLive(): Promise<{ ok: boolean; error?: string; items: ChillVideoItem[] }> {
  const r = await authFetch(`${base()}/youtube/live`, { method: 'GET' });
  const j = await r.json();
  return { ok: !!j.ok, error: j.error, items: j.items || [] };
}

export async function searchChill(q: string): Promise<{ ok: boolean; error?: string; items: ChillSearchItem[] }> {
  const u = new URL(`${base()}/youtube/search`);
  u.searchParams.set('q', q);
  const r = await authFetch(u.toString(), { method: 'GET' });
  const j = await r.json();
  return { ok: !!j.ok, error: j.error, items: j.items || [] };
}

export async function fetchChannelLive(
  channelId: string,
): Promise<{ ok: boolean; error?: string; videoId: string | null; title?: string }> {
  const u = new URL(`${base()}/youtube/channel-live`);
  u.searchParams.set('channelId', channelId);
  const r = await authFetch(u.toString(), { method: 'GET' });
  const j = await r.json();
  return {
    ok: !!j.ok,
    error: j.error,
    videoId: j.videoId ?? null,
    title: j.title,
  };
}
