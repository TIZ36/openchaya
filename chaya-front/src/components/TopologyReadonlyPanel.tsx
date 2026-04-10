/**
 * 知识行为拓扑只读面板：拉取 agent_topology、可选「从轨迹重建」。
 */

import React, { useEffect, useState } from 'react';
import { Loader, Network } from 'lucide-react';
import { api } from '../utils/apiClient';
import { Button } from './ui/Button';
import { toast } from './ui/use-toast';

export interface TopologyReadonlyPanelProps {
  agentId: string;
  topologyEnabled?: boolean;
}

const TopologyReadonlyPanel: React.FC<TopologyReadonlyPanelProps> = ({ agentId, topologyEnabled }) => {
  const [refreshKey, setRefreshKey] = useState(0);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    version?: number;
    builtAt?: string;
    nodeCount: number;
    pathCount: number;
    edgeSuccess: number;
    edgeTotal: number;
  } | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get<{
        graph?: { nodes?: Record<string, unknown>; edges?: Array<{ success?: number; total?: number }>; paths?: Record<string, unknown> };
        nodes?: unknown;
        edges?: Array<{ success?: number; total?: number }>;
        paths?: Record<string, unknown>;
        version?: number;
        built_at?: string;
      }>(`/api/agents/${encodeURIComponent(agentId)}/topology`)
      .then((data) => {
        if (cancelled) return;
        let g = data?.graph;
        if (!g && data && (data.nodes !== undefined || data.edges !== undefined)) {
          g = {
            nodes: data.nodes as Record<string, unknown>,
            edges: data.edges,
            paths: data.paths,
          };
        }
        let nodeCount = 0;
        let pathCount = 0;
        let edgeSuccess = 0;
        let edgeTotal = 0;
        if (g && typeof g === 'object') {
          if (g.nodes && typeof g.nodes === 'object') nodeCount = Object.keys(g.nodes).length;
          if (g.paths && typeof g.paths === 'object') pathCount = Object.keys(g.paths).length;
          if (Array.isArray(g.edges)) {
            for (const e of g.edges) {
              edgeSuccess += Number(e?.success ?? 0);
              edgeTotal += Number(e?.total ?? 0);
            }
          }
        }
        setStats({
          version: data?.version,
          builtAt: data?.built_at,
          nodeCount,
          pathCount,
          edgeSuccess,
          edgeTotal,
        });
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, refreshKey]);

  const edgeHitRate =
    stats && stats.edgeTotal > 0
      ? ((stats.edgeSuccess / stats.edgeTotal) * 100).toFixed(1)
      : null;

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:bg-[var(--niho-pure-black-elevated)]">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-[var(--color-bg-secondary)] [data-skin='niho']:bg-[var(--niho-text-bg)] [data-skin='niho']:border-b [data-skin='niho']:border-[var(--niho-text-border)]">
        <div className="flex items-center gap-2 min-w-0">
          <Network className="w-4 h-4 shrink-0 text-cyan-600 [data-skin='niho']:text-[var(--color-accent)]" />
          <span className="text-sm font-medium truncate [data-skin='niho']:text-[var(--text-primary)]">知识行为拓扑</span>
        </div>
        {topologyEnabled ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-[10px] px-2"
            disabled={rebuildBusy || loading || !agentId}
            onClick={async () => {
              setRebuildBusy(true);
              try {
                await api.post(`/api/agents/${encodeURIComponent(agentId)}/topology/rebuild`);
                toast({ title: '拓扑已更新', description: '已根据近 7 天对话轨迹合并到图谱（LLM 辅助）' });
                setRefreshKey((k) => k + 1);
              } catch (e) {
                toast({
                  title: '重建失败',
                  description: e instanceof Error ? e.message : String(e),
                  variant: 'destructive',
                });
              } finally {
                setRebuildBusy(false);
              }
            }}
          >
            {rebuildBusy ? <Loader className="w-3 h-3 animate-spin mr-1 inline" /> : null}
            从轨迹重建
          </Button>
        ) : null}
      </div>
      <div className="p-3 space-y-2 text-xs [data-skin='niho']:bg-[#000000] [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
        {topologyEnabled === false ? (
          <p className="rounded-md border border-amber-500/35 bg-amber-500/[0.07] px-2.5 py-2 text-[11px] leading-relaxed text-amber-900/90 dark:text-amber-100/90 [data-skin='niho']:border-[var(--color-secondary)]/35 [data-skin='niho']:bg-[var(--color-secondary)]/10 [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
            当前未开启「行为拓扑增强」。记忆锚点相关命中依赖拓扑构建的<strong className="font-normal text-[var(--text-primary)]">知识图谱</strong>
            ；请先打开上方开关后，后端才会按拓扑参与编排与统计。
          </p>
        ) : null}
        <p className="text-[11px] leading-relaxed">
          开启行为拓扑后，后端维护 <strong className="font-normal text-[var(--text-primary)]">agent_topology</strong>
          （知识图谱）。命中意图关键词时注入<strong className="font-normal text-[var(--text-primary)]">推荐步骤</strong>
          （MCP 工具名、技能 id 等），并与当前租户工具/技能目录对齐展示说明。
          可通过「从轨迹重建」用近 7 天 <code className="text-[10px] opacity-90">agent_traces</code> 调用模型合并图谱。
        </p>
        <p className="text-[11px] leading-relaxed opacity-90">
          下方为拓扑版本与基于边权重的<strong className="font-normal text-[var(--text-primary)]">参考命中率</strong>
          （边累计成功 / 尝试）。
        </p>
        {loading && (
          <div className="flex items-center gap-2 py-2 text-[var(--text-primary)]">
            <Loader className="w-4 h-4 animate-spin" />
            加载拓扑…
          </div>
        )}
        {!loading && err && <p className="text-amber-600 dark:text-amber-400 [data-skin='niho']:text-[var(--color-secondary)]">{err}</p>}
        {!loading && !err && stats && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-1">
            <dt className="text-[var(--color-text-tertiary)]">拓扑版本</dt>
            <dd className="text-[var(--text-primary)]">{stats.version ?? '—'}</dd>
            <dt className="text-[var(--color-text-tertiary)]">构建时间</dt>
            <dd className="text-[var(--text-primary)]">
              {stats.builtAt
                ? (() => {
                    try {
                      return new Date(stats.builtAt).toLocaleString('zh-CN');
                    } catch {
                      return stats.builtAt;
                    }
                  })()
                : '—'}
            </dd>
            <dt className="text-[var(--color-text-tertiary)]">节点数</dt>
            <dd className="text-[var(--text-primary)]">{stats.nodeCount}</dd>
            <dt className="text-[var(--color-text-tertiary)]">执行路径数</dt>
            <dd className="text-[var(--text-primary)]">{stats.pathCount}</dd>
            <dt className="text-[var(--color-text-tertiary)]">参考命中率</dt>
            <dd className="text-[var(--text-primary)]">
              {edgeHitRate != null ? `${edgeHitRate}% (${stats.edgeSuccess}/${stats.edgeTotal})` : '暂无边统计'}
            </dd>
          </dl>
        )}
      </div>
    </div>
  );
};

export default TopologyReadonlyPanel;
