/**
 * ElevenLabs Text-to-Speech API
 * Corresponds to backend /api/tts/*
 */

import { getBackendUrl } from '../utils/backendUrl';

const authFetch: typeof fetch = (input, init) => {
  const token = localStorage.getItem('chaya_token');
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(input, { ...init, headers });
};

const API_BASE = `${getBackendUrl()}/api/tts`;

export interface Voice {
  voice_id: string;
  name: string;
  category: string;
  gender: string;
  accent: string;
  age: string;
  description: string;
  preview_url: string;
}

export interface TTSSettings {
  stability?: number;
  similarity_boost?: number;
  model_id?: string;
  output_format?: string;
  optimize_streaming_latency?: number;
}

export interface UserInfo {
  character_count: number;
  character_limit: number;
  can_use_professional_voice_consistency: boolean;
  subscription_tier: string;
}

export async function fetchVoices(apiToken?: string): Promise<Voice[]> {
  const url = new URL(`${API_BASE}/voices`, window.location.origin);
  if (apiToken) {
    url.searchParams.append('api_token', apiToken);
  }

  const res = await authFetch(url.toString());
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || res.statusText || 'Failed to fetch voices');
  }
  const data = await res.json();
  return data.voices || [];
}

export async function getVoiceDetails(voiceId: string): Promise<Voice> {
  const res = await authFetch(`${API_BASE}/voices/${encodeURIComponent(voiceId)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || res.statusText || 'Failed to fetch voice details');
  }
  return res.json();
}

export async function synthesizeText(
  text: string,
  voiceId: string,
  settings: TTSSettings = {},
  apiToken?: string
): Promise<Blob> {
  const payload: any = {
    text,
    voice_id: voiceId,
    ...settings,
  };
  
  if (apiToken) {
    payload.api_token = apiToken;
  }

  const res = await authFetch(`${API_BASE}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || res.statusText || 'Failed to synthesize speech');
  }

  return res.blob();
}

export async function uploadCustomVoice(
  file: File,
  name: string,
  description?: string,
  apiToken?: string
): Promise<{ voice_id: string; name: string; message: string }> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('name', name);
  if (description) {
    formData.append('description', description);
  }
  if (apiToken) {
    formData.append('api_token', apiToken);
  }

  const res = await authFetch(`${API_BASE}/upload-voice`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || res.statusText || 'Failed to upload voice');
  }

  return res.json();
}

export async function deleteCustomVoice(voiceId: string, apiToken?: string): Promise<{ message: string }> {
  const url = new URL(`${API_BASE}/delete-voice/${encodeURIComponent(voiceId)}`, window.location.origin);
  if (apiToken) {
    url.searchParams.append('api_token', apiToken);
  }

  const res = await authFetch(url.toString(), {
    method: 'DELETE',
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || res.statusText || 'Failed to delete voice');
  }

  return res.json();
}

export async function getUserInfo(apiToken?: string): Promise<UserInfo> {
  const url = new URL(`${API_BASE}/user-info`, window.location.origin);
  if (apiToken) {
    url.searchParams.append('api_token', apiToken);
  }

  const res = await authFetch(url.toString());
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || res.statusText || 'Failed to fetch user info');
  }
  return res.json();
}
