/**
 * Actor 池监控弹窗
 * 显示正在工作的 Actor 列表：上下文大小、Persona、错误率、默认模型
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { getBackendUrl } from '../utils/backendUrl';
import { RefreshCw, Users } from 'lucide-react';

export interface ActorStatus {
  agent_id: string;
  topic_id: string;
  context_size: number;
  context_messages: number;
  persona: { name?: string; avatar?: string; system_prompt?: string };
  messages_processed: number;
  errors: number;
  error_rate: number;
  default_model: string;
  default_provider: string;
  is_running: boolean;
}

interface ActorPoolDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ActorPoolDialog: React.FC<ActorPoolDialogProps> = ({ open, onOpenChange }) => {
  const [actors, setActors] = useState<ActorStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendUrl, setBackendUrl] = useState('');

  const fetchPool = useCallback(async () => {
    const base = getBackendUrl();
    setBackendUrl(base);
    if (!base) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${base}/api/actor-pool/status`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.actors)) {
        setActors(data.actors);
      } else {
        setError(data.error || '获取失败');
        setActors([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败');
      setActors([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchPool();
  }, [open, fetchPool]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            Actor 池
          </DialogTitle>
          <DialogDescription>
            当前正在工作的 Agent（已激活的 Actor）及其状态
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end mb-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchPool}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>

        {loading && actors.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : error ? (
          <div className="py-8 text-center text-sm text-red-500">{error}</div>
        ) : actors.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            暂无已激活的 Actor
          </div>
        ) : (
          <div className="overflow-auto flex-1 no-scrollbar">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {actors.map((a) => (
                <div
                  key={a.agent_id + a.topic_id}
                  className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3 flex flex-col gap-2 text-sm"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {a.persona?.avatar ? (
                      <img
                        src={a.persona.avatar}
                        alt=""
                        className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-[var(--color-accent-bg)] flex items-center justify-center flex-shrink-0">
                        <Users className="w-4 h-4 text-[var(--color-accent)]" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{a.persona?.name || a.agent_id}</div>
                      <div className="text-xs text-[var(--text-muted)] truncate">{a.topic_id || '-'}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <span className="text-[var(--text-muted)]">上下文</span>
                    <span title={`${a.context_messages} 条消息`}>
                      {a.context_size.toLocaleString()} / {a.context_messages} 条
                    </span>
                    <span className="text-[var(--text-muted)]">错误率</span>
                    <span className={a.error_rate > 0 ? 'text-amber-500' : ''}>
                      {(a.error_rate * 100).toFixed(2)}% ({a.errors}/{a.messages_processed})
                    </span>
                    <span className="text-[var(--text-muted)] col-span-2">模型</span>
                    <span className="col-span-2 truncate">{a.default_model} · {a.default_provider}</span>
                  </div>
                  {a.persona?.system_prompt ? (
                    <p className="text-xs text-[var(--text-muted)] line-clamp-2 mt-0.5" title={a.persona.system_prompt}>
                      {a.persona.system_prompt}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ActorPoolDialog;
