/**
 * WebSocket hook for chaya-engine
 * Replaces SSE EventSource with bidirectional WS connection
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBackendUrl } from '../utils/backendUrl';

export interface WSEvent {
  type: string;
  agent_id?: string;
  message_id?: string;
  chunk?: string;
  accumulated?: string;
  content?: string;
  error?: string;
  time?: number;
  [key: string]: any;
}

type WSState = 'connecting' | 'connected' | 'disconnected';

interface UseWSOptions {
  onEvent?: (topic: string, event: WSEvent) => void;
  autoReconnect?: boolean;
}

export function useWebSocket(options: UseWSOptions = {}) {
  const { onEvent, autoReconnect = true } = options;
  const [state, setState] = useState<WSState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>();
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const getWsUrl = useCallback(() => {
    const base = getBackendUrl();
    const wsBase = base.replace(/^http/, 'ws');
    const token = localStorage.getItem('chaya_token') || '';
    return `${wsBase}/ws?token=${token}`;
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const url = getWsUrl();
    setState('connecting');

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setState('connected');
      console.log('[WS] connected');
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'event' && msg.payload) {
          const p = msg.payload as { type?: string };
          if (p?.type === 'usersession_ready') {
            return;
          }
        }
        if (msg.type === 'event' && msg.topic && msg.payload) {
          onEventRef.current?.(msg.topic, msg.payload);
        }
      } catch { /* ignore non-JSON */ }
    };

    ws.onclose = () => {
      setState('disconnected');
      console.log('[WS] disconnected');
      if (autoReconnect) {
        reconnectRef.current = setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => ws.close();
  }, [getWsUrl, autoReconnect]);

  useEffect(() => {
    const token = localStorage.getItem('chaya_token');
    if (token) connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const subscribe = useCallback((topic: string) => {
    send({ type: 'subscribe', topic });
  }, [send]);

  const unsubscribe = useCallback((topic: string) => {
    send({ type: 'unsubscribe', topic });
  }, [send]);

  const sendMessage = useCallback((convId: string, content: string, ext?: any) => {
    send({ type: 'message', payload: { conv_id: convId, content, ...ext } });
  }, [send]);

  const interrupt = useCallback((topic: string) => {
    send({ type: 'interrupt', topic });
  }, [send]);

  return { state, connect, send, subscribe, unsubscribe, sendMessage, interrupt };
}
