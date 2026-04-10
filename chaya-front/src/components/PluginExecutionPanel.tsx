import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Clock, FileJson, Image as ImageIcon, List, Loader2, Wrench } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { toast } from '@/components/ui/use-toast';
import { cn } from '@/utils/cn';
import { tryPrettyJson } from '@/utils/textUtils';
import { getMessageExecution, listSessionExecutions, type MessageExecution, type SessionExecutionItem } from '@/services/chat';

type TabKey = 'process' | 'raw' | 'error';

type MCPBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; data: string };

function extractMcpBlocks(rawResult: any): MCPBlock[] {
  const blocks: MCPBlock[] = [];

  const results = rawResult?.results;
  if (!Array.isArray(results)) return blocks;

  for (const r of results) {
    const toolName = r?.tool ? String(r.tool) : 'unknown_tool';
    blocks.push({ kind: 'text', text: `工具: ${toolName}` });

    const toolResult = r?.result;
    const contentArray = toolResult?.result?.content || toolResult?.content;
    if (!Array.isArray(contentArray)) {
      if (toolResult) {
        blocks.push({ kind: 'text', text: tryPrettyJson(JSON.stringify(toolResult, null, 2)) });
      }
      continue;
    }

    for (const item of contentArray) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        blocks.push({ kind: 'text', text: tryPrettyJson(item.text) });
        continue;
      }
      if (item?.type === 'image') {
        const mimeType = item.mimeType || item.mime_type;
        const data = item.data;
        if (typeof mimeType === 'string' && typeof data === 'string' && data.length > 0) {
          blocks.push({ kind: 'image', mimeType, data });
          continue;
        }
      }
      if (item !== undefined) {
        blocks.push({ kind: 'text', text: tryPrettyJson(JSON.stringify(item, null, 2)) });
      }
    }
  }

  return blocks;
}

function renderMcpBlocks(blocks: MCPBlock[]) {
  if (!blocks || blocks.length === 0) return null;

  return (
    <div className="space-y-2">
      {blocks.map((b, idx) => {
        if (b.kind === 'text') {
          return (
            <pre
              key={`mcp-text-${idx}`}
              className="bg-white dark:bg-[#2d2d2d] p-2 rounded border text-xs overflow-auto max-h-64 text-gray-800 dark:text-gray-100 whitespace-pre-wrap break-words"
            >
              {b.text}
            </pre>
          );
        }

        const src = `data:${b.mimeType};base64,${b.data}`;
        return (
          <div key={`mcp-image-${idx}`} className="relative">
            <img
              src={src}
              alt={`MCP 图片 ${idx + 1}`}
              className="max-w-full max-h-80 rounded-lg border border-gray-300 dark:border-[#404040] object-contain cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => {
                const win = window.open('', '_blank');
                if (win) {
                  win.document.write(`
                    <html>
                      <head><title>图片预览</title></head>
                      <body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#000">
                        <img src="${src}" style="max-width:100%;max-height:100vh;object-fit:contain;" />
                      </body>
                    </html>
                  `);
                }
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function PluginExecutionPanel(props: {
  messageId: string;
  sessionId?: string | null;
  toolType?: 'mcp' | 'workflow';
  className?: string;
}) {
  const { messageId, sessionId, toolType, className } = props;

  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('raw');
  const [loading, setLoading] = useState(false);
  const [execution, setExecution] = useState<MessageExecution | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // timeline dialog
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineItems, setTimelineItems] = useState<SessionExecutionItem[]>([]);
  const [timelineFilter, setTimelineFilter] = useState<'all' | 'mcp' | 'workflow'>('all');
  const [timelineSelectedMessageId, setTimelineSelectedMessageId] = useState<string | null>(null);
  const [timelineSelectedExecution, setTimelineSelectedExecution] = useState<MessageExecution | null>(null);

  const filteredTimelineItems = useMemo(() => {
    if (timelineFilter === 'all') return timelineItems;
    return timelineItems.filter(i => i.component_type === timelineFilter);
  }, [timelineFilter, timelineItems]);

  const mcpBlocks = useMemo(() => {
    if (!execution?.raw_result) return [];
    if ((execution.component_type || toolType) !== 'mcp') return [];
    return extractMcpBlocks(execution.raw_result);
  }, [execution, toolType]);

  const processLines = useMemo(() => {
    const logs = execution?.logs;
    if (!logs) return [];
    if (Array.isArray(logs)) return logs.map(x => String(x));
    return String(logs).split('\n');
  }, [execution]);

  const ensureLoaded = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getMessageExecution(messageId);
      setExecution(data);
      if (data?.status === 'error') setActiveTab('error');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  };

  const openPanel = async () => {
    const next = !open;
    setOpen(next);
    if (next && !execution && !loading) {
      await ensureLoaded();
    }
  };

  const openTimeline = async () => {
    setTimelineOpen(true);
    if (!sessionId) return;
    setTimelineLoading(true);
    try {
      const items = await listSessionExecutions(sessionId);
      setTimelineItems(items);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: '获取执行记录失败', description: msg, variant: 'destructive' });
    } finally {
      setTimelineLoading(false);
    }
  };

  const loadTimelineExecution = async (mid: string) => {
    setTimelineSelectedMessageId(mid);
    setTimelineSelectedExecution(null);
    try {
      const ex = await getMessageExecution(mid);
      setTimelineSelectedExecution(ex);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: '加载执行详情失败', description: msg, variant: 'destructive' });
    }
  };

  const TabButton = (p: { tab: TabKey; icon: React.ReactNode; label: string }) => (
    <Button
      variant={activeTab === p.tab ? 'secondary' : 'ghost'}
      size="sm"
      onClick={() => setActiveTab(p.tab)}
      className="h-8"
    >
      <span className="mr-1.5">{p.icon}</span>
      {p.label}
    </Button>
  );

  return (
    <div className={cn('mt-2', className)}>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={openPanel} className="h-8">
          <Wrench className="w-4 h-4 mr-1.5" />
          插件详情
          {open ? <ChevronUp className="w-4 h-4 ml-1.5" /> : <ChevronDown className="w-4 h-4 ml-1.5" />}
        </Button>
        {sessionId && (
          <Button variant="ghost" size="sm" onClick={openTimeline} className="h-8">
            <Clock className="w-4 h-4 mr-1.5" />
            本会话执行记录
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-2 rounded-lg border border-gray-200 dark:border-[#404040] bg-white/60 dark:bg-[#2d2d2d]/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-gray-700 dark:text-[#ffffff] uppercase tracking-wide">
              {toolType === 'mcp' ? 'MCP' : toolType === 'workflow' ? 'Workflow' : 'Plugin'} 执行详情（不会被模型改写）
            </div>
            <div className="flex items-center gap-1">
              <TabButton tab="process" icon={<List className="w-3.5 h-3.5" />} label="过程" />
              <TabButton tab="raw" icon={<FileJson className="w-3.5 h-3.5" />} label="原始结果" />
              <TabButton tab="error" icon={<span className="text-red-500 font-bold text-xs">!</span>} label="错误" />
            </div>
          </div>

          <div className="mt-3">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-[#b0b0b0]">
                <Loader2 className="w-4 h-4 animate-spin" />
                加载执行记录中...
              </div>
            ) : loadError ? (
              <div className="text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
                {loadError}
              </div>
            ) : !execution ? (
              <div className="text-sm text-gray-600 dark:text-[#b0b0b0]">暂无执行记录</div>
            ) : activeTab === 'process' ? (
              <ScrollArea className="h-56">
                <div className="space-y-1">
                  {processLines.length === 0 ? (
                    <div className="text-sm text-gray-600 dark:text-[#b0b0b0]">暂无过程日志</div>
                  ) : (
                    processLines.map((line, idx) => (
                      <div key={idx} className="text-xs text-gray-700 dark:text-gray-100 font-mono whitespace-pre-wrap break-words">
                        {line}
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            ) : activeTab === 'error' ? (
              <div className="text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
                {execution.error_message || (execution.status === 'error' ? '执行失败' : '无错误')}
              </div>
            ) : (
              <div className="space-y-3">
                {execution.component_type === 'mcp' && (
                  <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-[#b0b0b0]">
                    <ImageIcon className="w-4 h-4" />
                    支持图片/文本混排（按 MCP content[] 顺序展示）
                  </div>
                )}

                {execution.component_type === 'mcp' ? (
                  mcpBlocks.length > 0 ? (
                    renderMcpBlocks(mcpBlocks)
                  ) : (
                    <pre className="bg-white dark:bg-[#2d2d2d] p-2 rounded border text-xs overflow-auto max-h-64 text-gray-800 dark:text-gray-100 whitespace-pre-wrap break-words">
                      {tryPrettyJson(JSON.stringify(execution.raw_result ?? execution, null, 2))}
                    </pre>
                  )
                ) : (
                  <pre className="bg-white dark:bg-[#2d2d2d] p-2 rounded border text-xs overflow-auto max-h-64 text-gray-800 dark:text-gray-100 whitespace-pre-wrap break-words">
                    {tryPrettyJson(JSON.stringify(execution.raw_result ?? execution, null, 2))}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog open={timelineOpen} onOpenChange={setTimelineOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>本会话执行记录</DialogTitle>
            <DialogDescription>查看本会话内 MCP / Workflow 的执行历史与原始返回</DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-1">
              <Button
                variant={timelineFilter === 'all' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setTimelineFilter('all')}
              >
                全部
              </Button>
              <Button
                variant={timelineFilter === 'mcp' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setTimelineFilter('mcp')}
              >
                MCP
              </Button>
              <Button
                variant={timelineFilter === 'workflow' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setTimelineFilter('workflow')}
              >
                Workflow
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-gray-200 dark:border-[#404040]">
              <ScrollArea className="h-[420px] p-2">
                {timelineLoading ? (
                  <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-[#b0b0b0] p-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    加载中...
                  </div>
                ) : filteredTimelineItems.length === 0 ? (
                  <div className="text-sm text-gray-600 dark:text-[#b0b0b0] p-2">暂无记录</div>
                ) : (
                  <div className="space-y-2">
                    {filteredTimelineItems.map(item => {
                      const selected = item.message_id === timelineSelectedMessageId;
                      return (
                        <div
                          key={item.execution_id}
                          className={cn(
                            'rounded-md border p-2 transition-colors',
                            selected
                              ? 'border-primary-300 dark:border-primary-700 bg-primary-50/60 dark:bg-primary-900/20'
                              : 'border-gray-200 dark:border-[#404040] hover:bg-gray-50 dark:hover:bg-[#2d2d2d]'
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-gray-900 dark:text-[#ffffff] truncate">
                                {item.component_type.toUpperCase()} · {item.component_name || item.component_id || '执行'}
                              </div>
                              <div className="text-xs text-gray-500 dark:text-[#b0b0b0] truncate">
                                {item.created_at || ''} · {item.status}
                              </div>
                            </div>
                            <Button variant="outline" size="sm" onClick={() => loadTimelineExecution(item.message_id)}>
                              查看
                            </Button>
                          </div>
                          {item.error_message && (
                            <div className="text-xs text-red-600 dark:text-red-400 mt-1 truncate">
                              {item.error_message}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-[#404040]">
              <ScrollArea className="h-[420px] p-2">
                {!timelineSelectedExecution ? (
                  <div className="text-sm text-gray-600 dark:text-[#b0b0b0] p-2">
                    选择左侧一条记录查看详情
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="text-xs font-semibold text-gray-700 dark:text-[#ffffff] uppercase tracking-wide">
                      执行详情
                    </div>
                    {timelineSelectedExecution.component_type === 'mcp' ? (
                      (() => {
                        const blocks = extractMcpBlocks(timelineSelectedExecution.raw_result);
                        return blocks.length > 0 ? (
                          renderMcpBlocks(blocks)
                        ) : (
                          <pre className="bg-white dark:bg-[#2d2d2d] p-2 rounded border text-xs overflow-auto max-h-96 text-gray-800 dark:text-gray-100 whitespace-pre-wrap break-words">
                            {tryPrettyJson(JSON.stringify(timelineSelectedExecution.raw_result ?? timelineSelectedExecution, null, 2))}
                          </pre>
                        );
                      })()
                    ) : (
                      <pre className="bg-white dark:bg-[#2d2d2d] p-2 rounded border text-xs overflow-auto max-h-96 text-gray-800 dark:text-gray-100 whitespace-pre-wrap break-words">
                        {tryPrettyJson(JSON.stringify(timelineSelectedExecution.raw_result ?? timelineSelectedExecution, null, 2))}
                      </pre>
                    )}
                  </div>
                )}
              </ScrollArea>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}


