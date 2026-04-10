/**
 * ProcessStepsViewer - 思考链（Niho 风格）
 * 参考 niho/skr：一行多个 tag，每个 tag 代表一种信息，hover 展示详情
 * 步骤归类：1. 思考  2. MCP 调用  3. 决策
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Cpu,
  Wrench,
  Target,
  Lightbulb,
  Loader2,
  QrCode,
  Sparkles,
  MessageSquare,
  Check,
  X,
  Brain,
  Quote,
  SquareStop,
} from 'lucide-react';
import { truncateBase64Strings } from '../../utils/textUtils';
import { parseMCPContentBlocks, renderMCPBlocks } from '../workflow/mcpRender';
import type { ProcessMessage } from '../../types/processMessage';
import type { MindNode } from '../../types/agentResponse';
import { Button } from './Button';

/**
 * 将新的 MindNode 转换为 ProcessMessage 格式
 * 用于向后兼容现有的渲染逻辑
 */
function convertMindNodeToProcessMessage(node: MindNode): ProcessMessage {
  // 映射思维节点类型到处理消息类型
  const typeMapping: Record<string, string> = {
    'thinking': 'thinking',
    'mcp_selection': 'mcp_call',
    'iteration': 'agent_decision',
    'decision': 'agent_decision',
    'planning': 'agent_decision',
    'reflection': 'thinking',
  };
  
  const type = typeMapping[node.type] || node.type;
  
  return {
    type,
    contentType: 'text',
    timestamp: node.timestamp,
    title: node.title,
    content: node.content,
    meta: {
      step_id: node.id,
      status: node.status,
      duration: node.duration,
      error: node.error,
      // MCP 信息
      mcpServer: node.mcp?.server,
      mcpServerName: node.mcp?.serverName,
      toolName: node.mcp?.toolName,
      arguments: node.mcp?.arguments,
      result: node.mcp?.result,
      // 迭代信息
      iteration: node.iteration?.round,
      max_iterations: node.iteration?.maxRounds,
      is_final_iteration: node.iteration?.isFinal,
      // 决策信息
      action: node.decision?.action,
      thinking: node.content || node.decision?.reason,
      // 保留原始数据
      _mindNode: node,
    },
  };
}
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './Dialog';
import type { ExecutionLogEntry } from './ExecutionLogViewer';
import { ExecutionLogScroller } from './ExecutionLogScroller';

export interface ProcessStepsViewerProps {
  processMessages?: ProcessMessage[];
  executionLogs?: ExecutionLogEntry[];
  ext?: any;
  isThinking?: boolean;
  isStreaming?: boolean;
  title?: string;
  defaultExpanded?: boolean;
  hideTitle?: boolean;
  showTags?: boolean;
  onQuote?: () => void;
  /** 打断生成回调，传入时在思维链右侧显示雾粉色打断按钮（仅 isThinking/isStreaming 时显示） */
  onInterrupt?: () => void;
}

/** 步骤归类：思考 / MCP调用 / 决策 / 输出 */
function stepCategory(step: ProcessMessage): 'thinking' | 'mcp' | 'decision' | 'output' {
  const t = step.type;
  // 思考/模型输出类
  if (t === 'thinking' || t === 'llm_generating' || t === 'llm_metadata' || t === 'llm_media_signature') return 'thinking';
  // 工具调用类
  if (t === 'mcp_call' || t === 'ag_use_mcp' || t === 'workflow') return 'mcp';
  // 输出类
  if (t === 'output') return 'output';
  // 决策/流程控制类（包括消息处理各阶段）
  if (t === 'llm_decision' || t === 'agent_deciding' || t === 'agent_decision' || 
      t === 'load_llm_tool' || t === 'prepare_context' || t === 'msg_classify' ||
      t === 'msg_pre_deal' || t === 'msg_deal' || t === 'post_msg_deal') return 'decision';
  return 'decision';
}

/** 标签短文案 */
function stepTagLabel(step: ProcessMessage): string {
  switch (step.type) {
    case 'thinking':
      return '思考';
    case 'llm_generating':
      return '模型输出';
    case 'llm_decision':
      return step.meta?.decision ? `决策·${step.meta.decision}` : '正在决策';
    case 'llm_metadata':
      return 'LLM';
    case 'llm_media_signature':
      return '图片';
    case 'mcp_call':
    case 'ag_use_mcp':
      return step.title ? `工具·${step.title}` : '使用工具';
    case 'agent_deciding':
      return `决策中 · ${step.meta?.agent_name || 'Agent'}`;
    case 'agent_decision':
      return `决策 · ${step.meta?.action || '—'}`;
    case 'agent_activated':
      return '激活';
    case 'output':
      return '输出';
    case 'agent_will_reply':
      return '决定回答';
    case 'workflow':
      return `工作流 · ${step.meta?.workflowInfo?.name || '—'}`;
    case 'load_llm_tool':
      return '加载配置';
    case 'prepare_context':
      return '准备上下文';
    case 'msg_classify':
      return '消息分类';
    case 'msg_pre_deal':
      return '预处理';
    case 'msg_deal':
      return '处理消息';
    case 'post_msg_deal':
      return '后处理';
    default:
      return step.type;
  }
}

export const ProcessStepsViewer: React.FC<ProcessStepsViewerProps> = ({
  processMessages,
  executionLogs,
  ext,
  isThinking,
  isStreaming,
  title = '思考链',
  defaultExpanded = true,
  hideTitle = false,
  showTags = true,
  onQuote,
  onInterrupt,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'mind' | 'log'>('mind');
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number; transform?: string; marginTop?: number } | null>(null);
  const tagRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleClose = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setHoveredIndex(null), 150);
  };
  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const orderedSteps = useMemo(() => {
    // 优先使用新结构 ext.agent_mind.nodes，向后兼容 processMessages
    let baseMessages: ProcessMessage[] = [];
    
    // 1. 直接传入的 processMessages
    if (processMessages?.length) {
      baseMessages = processMessages;
    }
    // 2. 新结构：ext.agent_mind.nodes
    else if (ext?.agent_mind?.nodes && Array.isArray(ext.agent_mind.nodes)) {
      baseMessages = ext.agent_mind.nodes.map((node: any) => convertMindNodeToProcessMessage(node));
    }
    // 3. 旧结构：ext.processMessages
    else if (ext?.processMessages && Array.isArray(ext.processMessages)) {
      baseMessages = ext.processMessages;
    }
    
    // 即使没有消息，如果正在流式输出，也要显示占位
    if (!baseMessages.length && !isStreaming && !isThinking) return [];
    
    const list = [...baseMessages];
    const now = Date.now();
    
    // 思考状态处理
    const hasThinking = list.some(m => m.type === 'thinking' || m.type === 'llm_generating');
    if (isThinking && !hasThinking) {
      // 添加思考占位
      list.push({
        type: 'thinking',
        contentType: 'text',
        timestamp: now - 2,
        title: '思考中',
        content: '',
        meta: { status: 'running' },
      });
    } else if (isThinking) {
      // 确保最后一个思考步骤显示为 running
      const lastThinking = [...list].reverse().find(m => m.type === 'thinking' || m.type === 'llm_generating');
      if (lastThinking && lastThinking.meta?.status !== 'running') {
        lastThinking.meta = { ...(lastThinking.meta || {}), status: 'running' };
      }
    }
    
    // MCP 调用状态 - 确保正在执行的 MCP 显示 running
    list.forEach(m => {
      if ((m.type === 'mcp_call' || m.type === 'ag_use_mcp') && !m.meta?.status) {
        m.meta = { ...(m.meta || {}), status: 'running' };
      }
    });
    
    // 输出状态处理
    const hasOutput = list.some(m => m.type === 'output' || m.type === 'llm_generating');
    if (isStreaming && !hasOutput) {
      list.push({
        type: 'output',
        contentType: 'text',
        timestamp: now,
        title: '输出中',
        content: '',
        meta: { status: 'running' },
      });
    } else if (isStreaming) {
      // 确保输出步骤显示为 running
      const outputStep = list.find(m => m.type === 'output' || m.type === 'llm_generating');
      if (outputStep && outputStep.meta?.status !== 'running') {
        outputStep.meta = { ...(outputStep.meta || {}), status: 'running' };
      }
    }
    const sorted = [...list];
    sorted.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    return sorted;
  }, [processMessages, ext?.processMessages, isStreaming, isThinking]);

  // 思维链右侧垂直滚动：优先展示 ext.agent_log，向后兼容 executionLogs
  const inlineLogs: ExecutionLogEntry[] = useMemo(() => {
    // 标准化日志条目（兼容 type 和 log_type）
    const normalizeLog = (log: any): ExecutionLogEntry => ({
      ...log,
      type: log.type || log.log_type || 'info',
    });
    
    // 1. 新结构：ext.agent_log
    if (ext?.agent_log && Array.isArray(ext.agent_log) && ext.agent_log.length > 0) {
      return ext.agent_log.map(normalizeLog);
    }
    // 2. 向后兼容：ext.log
    if (ext?.log && Array.isArray(ext.log) && ext.log.length > 0) {
      return ext.log.map(normalizeLog);
    }
    // 3. 传入的 executionLogs
    if (Array.isArray(executionLogs) && executionLogs.length > 0) {
      return executionLogs.map(normalizeLog);
    }
    const base = (orderedSteps || []).filter(Boolean) as ProcessMessage[];
    if (base.length === 0) return [];

    const mapType = (pm: ProcessMessage): ExecutionLogEntry['type'] => {
      const t = String(pm.type || '').toLowerCase();
      if (t.includes('thinking') || t.includes('llm_generating')) return 'thinking';
      if (t.includes('mcp_call') || t.includes('ag_use_mcp') || t.includes('mcp') || t.includes('tool')) return 'tool';
      if (t.includes('llm')) return 'llm';
      if (t.includes('output')) return 'llm';
      return 'step';
    };

    return base
      .map((pm) => {
        const type = mapType(pm);
        const titleText = typeof pm.title === 'string' ? pm.title.trim() : '';
        const contentText = typeof pm.content === 'string' ? pm.content.trim() : '';

        // 避免把“思考中/输出中”这种占位塞进右侧滚动区（你明确不想看到无意义文案）
        if (!contentText && (titleText === '思考中' || titleText === '输出中')) return null;

        const message = contentText || titleText;
        if (!message) return null;

        return {
          id: `pm-${pm.timestamp}-${pm.type}-${titleText || 'x'}`,
          timestamp: typeof pm.timestamp === 'number' ? pm.timestamp : Date.now(),
          type,
          // message 用于过滤；detail 用于 thinking 短摘（ExecutionLogScroller 会优先用 detail）
          message: titleText || message,
          detail: contentText || undefined,
        } as ExecutionLogEntry;
      })
      .filter(Boolean) as ExecutionLogEntry[];
  }, [executionLogs, orderedSteps]);

  useEffect(() => {
    const activeIndex = pinnedIndex ?? hoveredIndex;
    if (activeIndex === null) {
      setPopoverPos(null);
      return;
    }
    const el = tagRefs.current[activeIndex];
    const wrapEl = wrapRef.current;
    if (!el || !wrapEl) return;
    const rect = el.getBoundingClientRect();
    const wrapRect = wrapEl.getBoundingClientRect();
    const popoverWidth = 320;
    const centerLeft = rect.left + rect.width / 2;
    const leftViewport = Math.max(8 + popoverWidth / 2, Math.min(centerLeft, window.innerWidth - popoverWidth / 2 - 8));
    const left = leftViewport - wrapRect.left;
    const preferAbove = true;
    setPopoverPos({
      top: preferAbove ? (rect.top - wrapRect.top) : (rect.bottom - wrapRect.top + 8),
      left,
      transform: preferAbove ? 'translate(-50%, -100%)' : 'translateX(-50%)',
      marginTop: preferAbove ? -8 : 0,
    });
  }, [hoveredIndex, pinnedIndex]);

  useEffect(() => {
    if (pinnedIndex === null) return;
    const onDocClick = (event: MouseEvent) => {
      const wrapEl = wrapRef.current;
      if (!wrapEl) return;
      if (!wrapEl.contains(event.target as Node)) {
        setPinnedIndex(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [pinnedIndex]);

  // 无步骤时也渲染，以便处理中（isThinking/isStreaming）时显示思维链右侧的打断按钮
  if (orderedSteps.length === 0 && !((isThinking || isStreaming) && onInterrupt)) return null;

  const formatDuration = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const formatTime = (timestamp?: number) => {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const isRunningStatus = (status?: string) => {
    const s = String(status || '').toLowerCase();
    return s === 'running' || s === 'pending' || s === 'iterating' || s === 'processing';
  };

  const renderDetailBody = (msg: ProcessMessage, options?: { showMetaLine?: boolean }) => {
    const showMetaLine = options?.showMetaLine ?? true;
    const metaLine = [
      stepTagLabel(msg),
      msg.meta?.status ? `状态: ${msg.meta.status}` : null,
      msg.meta?.duration != null ? `耗时: ${formatDuration(msg.meta.duration)}` : null,
    ].filter(Boolean).join(' · ');

    const textItems: string[] = [];
    const images: Array<{ mimeType: string; data: string }> = [];
    if (msg.contentType === 'text' && msg.content) textItems.push(msg.content);
    if (msg.meta?.thinking && (!msg.content || msg.content !== msg.meta.thinking)) {
      textItems.push(String(msg.meta.thinking));
    }
    if (msg.contentType === 'image' && msg.image) images.push(msg.image);
    if (msg.contentType === 'images' && Array.isArray(msg.images)) images.push(...msg.images);
    if (msg.meta?.result) {
      const blocks = parseMCPContentBlocks(msg.meta.result);
      blocks.forEach(b => {
        if (b.kind === 'text') textItems.push(b.text);
        if (b.kind === 'image') images.push({ mimeType: b.mimeType, data: b.data });
      });
    }

    const imageBlocks = images.map(img => ({ kind: 'image' as const, mimeType: img.mimeType, data: img.data }));

    return (
      <div className="space-y-2 p-2">
        {showMetaLine && metaLine && <div className="text-[10px] text-muted-foreground">{metaLine}</div>}
        {imageBlocks.length > 0 && (
          <div className="rounded border border-primary/30 bg-primary/5 p-2">
            <div className="flex items-center gap-1 text-[10px] font-medium text-primary mb-1">
              <QrCode className="w-3.5 h-3.5" /> 图片
            </div>
            <div className="[&_img]:max-h-32 [&_img]:w-auto">
              {renderMCPBlocks({ blocks: imageBlocks, openSingleMediaViewer: () => {} })}
            </div>
          </div>
        )}
        {msg.meta?.arguments && (
          <div className="rounded border border-border/50 bg-muted/40 p-2">
            <div className="text-[10px] text-muted-foreground mb-1">参数</div>
            <pre className="text-[10px] whitespace-pre-wrap break-words max-h-32 overflow-auto">
              {truncateBase64Strings(JSON.stringify(msg.meta.arguments, null, 2))}
            </pre>
          </div>
        )}
        {msg.meta?.error && (
          <div className="rounded border border-red-500/30 bg-red-500/10 p-2">
            <div className="text-[10px] text-red-400 mb-1">错误</div>
            <div className="text-[10px] text-red-400 whitespace-pre-wrap break-words">
              {String(msg.meta.error)}
            </div>
          </div>
        )}
        {msg.meta?.workflowInfo?.result && (
          <div className="rounded border border-border/50 bg-muted/40 p-2">
            <div className="text-[10px] text-muted-foreground mb-1">工作流结果</div>
            <pre className="text-[10px] whitespace-pre-wrap break-words max-h-40 overflow-auto">
              {String(msg.meta.workflowInfo.result).slice(0, 1000)}
            </pre>
          </div>
        )}
        {textItems.length > 0 && (
          <div className="rounded border border-border/50 bg-muted/40 p-2">
            <div className="text-[10px] text-muted-foreground mb-1">
              {(msg.type === 'thinking' || msg.type === 'llm_generating') ? '思考内容' : '文本'}
            </div>
            <div className="space-y-1 max-h-48 overflow-auto">
              {textItems.map((t, i) => (
                <pre key={i} className="text-[10px] whitespace-pre-wrap break-words">
                  {truncateBase64Strings(t)}
                </pre>
              ))}
            </div>
          </div>
        )}
        {!imageBlocks.length && !textItems.length && !msg.meta?.arguments && !msg.meta?.error && !msg.meta?.workflowInfo?.result && (
          <div className="text-[10px] text-muted-foreground">
            {isRunningStatus(msg.meta?.status) ? '进行中...' : '暂无详情'}
          </div>
        )}
      </div>
    );
  };

  const categoryStyle = (cat: 'thinking' | 'mcp' | 'decision' | 'output') => {
    switch (cat) {
      case 'thinking':
        // 紫色系 -> 霓虹粉 (Niho)
        return 'process-tag-thinking bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30 dark:bg-violet-500/15';
      case 'mcp':
        // 青色系 -> 霓虹青 (Niho)
        return 'process-tag-mcp bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30 dark:bg-cyan-500/15';
      case 'decision':
        // 橙色系 -> 淡金色 (Niho)
        return 'process-tag-decision bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30 dark:bg-orange-500/15';
      case 'output':
        // 绿色系 -> 荧光绿 (Niho)
        return 'process-tag-output bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 dark:bg-emerald-500/15';
      default:
        return 'bg-muted/50 text-muted-foreground border-border';
    }
  };


  const renderTag = (step: ProcessMessage, idx: number) => {
    const cat = stepCategory(step);
    const label = stepTagLabel(step);
    const hasContent = !!(step.content || step.image || step.images || step.meta?.result || step.meta?.error || step.meta?.workflowInfo?.result || step.meta?.arguments || step.meta?.thinking);
    const isPinned = pinnedIndex === idx;
    const isRunning = isRunningStatus(step.meta?.status) || (step.type === 'thinking' && isThinking) || (step.type === 'output' && isStreaming);

    return (
      <span
        key={`${step.type}-${step.timestamp ?? idx}`}
        ref={el => { tagRefs.current[idx] = el; }}
        onMouseEnter={() => { cancelClose(); hasContent && setHoveredIndex(idx); }}
        onMouseLeave={() => scheduleClose()}
        onClick={() => {
          if (!hasContent) return;
          cancelClose();
          setPinnedIndex(isPinned ? null : idx);
          setHoveredIndex(idx);
        }}
        className={`
          inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium
          transition-all
          ${categoryStyle(cat)}
          ${hasContent ? 'cursor-pointer hover:opacity-90 hover:-translate-y-[1px]' : ''}
          ${isPinned ? 'ring-1 ring-primary/40' : ''}
        `}
      >
        {step.type === 'llm_generating'
          ? <Cpu className="w-2.5 h-2.5 flex-shrink-0" />
          : cat === 'thinking' && <Brain className="w-2.5 h-2.5 flex-shrink-0" />}
        {cat === 'mcp' && <Wrench className="w-2.5 h-2.5 flex-shrink-0" />}
        {cat === 'decision' && <Target className="w-2.5 h-2.5 flex-shrink-0" />}
        {cat === 'output' && <MessageSquare className="w-2.5 h-2.5 flex-shrink-0" />}
        <span className="process-step-tag-label truncate max-w-[120px]">{label}</span>
        {/* 状态指示器：执行中/成功/失败 */}
        <span className="ml-0.5 flex-shrink-0">
          {isRunning ? (
            <Loader2 className="w-2.5 h-2.5 animate-spin text-current opacity-70" />
          ) : step.meta?.status === 'error' ? (
            <X className="w-2.5 h-2.5 text-red-500" />
          ) : step.meta?.status === 'completed' ? (
            <Check className="w-2.5 h-2.5 text-emerald-500" />
          ) : null}
        </span>
      </span>
    );
  };

  const tagsContent = (
    <div className="process-steps-viewer flex flex-wrap items-center gap-1">
      {orderedSteps.map((step, idx) => (
        <React.Fragment key={`${step.type}-${step.timestamp ?? idx}`}>
          {renderTag(step, idx)}
          {idx < orderedSteps.length - 1 && (
            <span className="text-[9px] text-muted-foreground opacity-60">→</span>
          )}
        </React.Fragment>
      ))}
    </div>
  );

  return (
    <div ref={wrapRef} className={`process-steps-viewer-wrap relative ${hideTitle ? '' : 'mt-1.5'}`}>
      {!hideTitle && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full justify-start gap-1.5 px-0 py-1 text-left h-auto hover:bg-muted/50"
        >
          {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          <span className="font-medium text-xs text-foreground">{title}</span>
          <span className="text-[10px] text-muted-foreground">{orderedSteps.length} 步</span>
          {ext?.llmInfo && <span className="text-[10px] text-muted-foreground">{ext.llmInfo.provider}/{ext.llmInfo.model}</span>}
        </Button>
      )}
      {(hideTitle || isExpanded) && (
        <div className={`${hideTitle ? '' : 'mt-1'} flex items-start gap-2`}>
          {showTags ? <div className="min-w-0 flex-1">{tagsContent}</div> : null}
          <div className="flex items-center gap-1">
            {onQuote && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onQuote}
                aria-label="引用此消息"
                title="引用此消息"
                className="h-6 w-6"
              >
                <Quote className="w-3 h-3" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTimelineOpen(true)}
              aria-label="查看过程详情"
              title="查看过程详情"
              className={`h-6 w-6 flex-shrink-0 ${(isThinking || isStreaming) ? 'thinking-brain-icon' : ''}`}
            >
              <Brain className={`w-3 h-3 transition-transform ${(isThinking || isStreaming) ? 'animate-bounce text-primary' : ''}`} />
            </Button>
            {/* 开始处理时在思维链右侧显示雾粉色打断按钮 */}
            {(isThinking || isStreaming) && onInterrupt && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onInterrupt}
                aria-label="打断生成"
                title="打断生成"
                className="h-6 px-1.5 flex-shrink-0 text-[11px] font-medium bg-[var(--color-secondary)] text-black border-0 hover:opacity-90 [data-skin=niho]:bg-[var(--color-secondary)] [data-skin=niho]:text-black [data-skin=niho]:border-0 [data-skin=niho]:hover:bg-[var(--niho-mist-pink)]"
              >
                <SquareStop className="w-3 h-3 mr-0.5" />
                打断
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Hover 详情浮层 */}
      {(pinnedIndex !== null || hoveredIndex !== null) && popoverPos !== null && orderedSteps[(pinnedIndex ?? hoveredIndex)!] && (
        <div
          className="process-steps-popover absolute z-[100] w-[min(280px,88vw)] rounded-md border border-border bg-card/90 backdrop-blur-md shadow-lg overflow-hidden"
          style={{
            top: popoverPos.top,
            left: popoverPos.left,
            transform: popoverPos.transform,
            marginTop: popoverPos.marginTop,
          }}
          onMouseEnter={() => { cancelClose(); setHoveredIndex(hoveredIndex); }}
          onMouseLeave={() => scheduleClose()}
        >
          <div
            className={`absolute left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-card border border-border ${
              popoverPos.transform?.includes('-100%') ? 'top-full -mt-1' : 'bottom-full -mb-1'
            }`}
          />
          <div className="border-b border-border px-2 py-1 text-[10px] font-medium text-foreground">
            {stepTagLabel(orderedSteps[(pinnedIndex ?? hoveredIndex)!])}
          </div>
          {renderDetailBody(orderedSteps[(pinnedIndex ?? hoveredIndex)!])}
          <div className="border-t border-border px-2 py-1 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const msg = orderedSteps[(pinnedIndex ?? hoveredIndex)!];
                const texts = [msg.content].filter(Boolean).join('\\n\\n');
                const resultText = msg.meta?.result ? JSON.stringify(msg.meta.result, null, 2) : '';
                if (texts) navigator.clipboard.writeText(texts);
                if (!texts && resultText) navigator.clipboard.writeText(resultText);
              }}
            >
              复制
            </Button>
          </div>
        </div>
      )}

      <Dialog open={timelineOpen} onOpenChange={setTimelineOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Agent 处理详情</DialogTitle>
          </DialogHeader>
          
          {/* Tab 切换 */}
          <div className="flex items-center gap-1 border-b border-border">
            <button
              onClick={() => setActiveTab('mind')}
              className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                activeTab === 'mind'
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <Brain className="w-4 h-4" />
                <span>思维链</span>
                <span className="text-[10px] opacity-60">({orderedSteps.length})</span>
              </div>
              {activeTab === 'mind' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </button>
            <button
              onClick={() => setActiveTab('log')}
              className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                activeTab === 'log'
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <Cpu className="w-4 h-4" />
                <span>执行日志</span>
                <span className="text-[10px] opacity-60">
                  ({(() => {
                    const logs = (ext as any)?.agent_log || (ext as any)?.log || executionLogs || [];
                    return Array.isArray(logs) ? logs.length : 0;
                  })()})
                </span>
              </div>
              {activeTab === 'log' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </button>
          </div>
          
          <div className="max-h-[70vh] overflow-auto space-y-3 pr-1 no-scrollbar mt-2">
            {/* 思维链 Tab */}
            {activeTab === 'mind' && (
              <>
                {orderedSteps.map((step, idx) => {
                  const cat = stepCategory(step);
                  const label = stepTagLabel(step);
                  const isRunning = isRunningStatus(step.meta?.status) || (step.type === 'thinking' && isThinking) || (step.type === 'output' && isStreaming);
                  return (
                    <div
                      key={`${step.type}-${step.timestamp ?? idx}`}
                      className="rounded-md border border-border/60 bg-muted/30"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-border/60">
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span className="text-[11px] text-muted-foreground">
                            {formatTime(step.timestamp)}
                            {step.meta?.duration != null && (
                              <span className="opacity-60 ml-1">({formatDuration(step.meta.duration)})</span>
                            )}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${categoryStyle(cat)}`}
                          >
                            {label}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          {isRunning ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : step.meta?.status === 'error' ? (
                            <X className="w-3 h-3 text-red-500" />
                          ) : step.meta?.status === 'completed' ? (
                            <Check className="w-3 h-3 text-emerald-500" />
                          ) : null}
                        </div>
                      </div>
                      <div className="px-1 pb-1">
                        {renderDetailBody(step, { showMetaLine: false })}
                      </div>
                    </div>
                  );
                })}
                {orderedSteps.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    暂无思维链数据
                  </div>
                )}
              </>
            )}
            
            {/* 执行日志 Tab */}
            {activeTab === 'log' && (
              <>
                {(() => {
                  // 优先从 ext.agent_log 读取，向后兼容 ext.log 和 executionLogs
                  const logs = (ext as any)?.agent_log || (ext as any)?.log || executionLogs || [];
                  if (!Array.isArray(logs) || logs.length === 0) {
                    return (
                      <div className="text-center py-8 text-muted-foreground text-sm">
                        暂无执行日志
                      </div>
                    );
                  }
                  
                  // 获取日志类型（兼容 type 和 log_type）
                  const getLogType = (log: any): string => log.type || log.log_type || 'info';
                  
                  // 按类型分组日志
                  const logTypeIcon = (type: string) => {
                    switch (type) {
                      case 'thinking': return <Brain className="w-3 h-3 text-violet-500" />;
                      case 'tool': case 'mcp': return <Wrench className="w-3 h-3 text-cyan-500" />;
                      case 'llm': return <Cpu className="w-3 h-3 text-blue-500" />;
                      case 'step': return <Target className="w-3 h-3 text-orange-500" />;
                      case 'success': return <Check className="w-3 h-3 text-emerald-500" />;
                      case 'error': return <X className="w-3 h-3 text-red-500" />;
                      case 'iteration': return <Sparkles className="w-3 h-3 text-purple-500" />;
                      case 'info': return <Lightbulb className="w-3 h-3 text-yellow-500" />;
                      default: return <MessageSquare className="w-3 h-3 text-muted-foreground" />;
                    }
                  };
                  
                  const logTypeBg = (type: string) => {
                    switch (type) {
                      case 'thinking': return 'bg-violet-500/5 border-violet-500/20';
                      case 'tool': case 'mcp': return 'bg-cyan-500/5 border-cyan-500/20';
                      case 'llm': return 'bg-blue-500/5 border-blue-500/20';
                      case 'step': return 'bg-orange-500/5 border-orange-500/20';
                      case 'success': return 'bg-emerald-500/5 border-emerald-500/20';
                      case 'error': return 'bg-red-500/5 border-red-500/20';
                      case 'iteration': return 'bg-purple-500/5 border-purple-500/20';
                      case 'info': return 'bg-yellow-500/5 border-yellow-500/20';
                      default: return 'bg-muted/30 border-border/60';
                    }
                  };
                  
                  // 格式化详情（支持对象和字符串）
                  const formatDetail = (detail: any): string => {
                    if (!detail) return '';
                    if (typeof detail === 'string') return detail;
                    try {
                      return JSON.stringify(detail, null, 2);
                    } catch {
                      return String(detail);
                    }
                  };
                  
                  return logs.map((log: any, idx: number) => {
                    const logType = getLogType(log);
                    const detailStr = formatDetail(log.detail);
                    return (
                      <div
                        key={log.id || idx}
                        className={`rounded-md border p-3 ${logTypeBg(logType)}`}
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex-shrink-0 mt-0.5">
                            {logTypeIcon(logType)}
                          </div>
                          <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] text-muted-foreground">
                              {new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                              <span className="opacity-50">.{String(log.timestamp % 1000).padStart(3, '0')}</span>
                              {log.duration != null && (
                                <span className="opacity-60 ml-1">({log.duration < 1000 ? `${log.duration}ms` : `${(log.duration / 1000).toFixed(2)}s`})</span>
                              )}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              {logType}
                            </span>
                            {log.agent_name && (
                              <span className="text-[10px] text-muted-foreground opacity-70">
                                {log.agent_name}
                              </span>
                            )}
                          </div>
                            <div className="mt-1 text-sm text-foreground">
                              {log.message}
                            </div>
                            {/* MCP 工具参数详情（独立框显示） */}
                            {detailStr && logType === 'tool' && (
                              <div className="mt-1.5 rounded border border-cyan-500/30 bg-cyan-500/5 p-2">
                                <div className="text-[10px] text-cyan-600 dark:text-cyan-400 font-medium mb-1">📦 工具参数</div>
                                <pre className="text-[11px] text-foreground/80 whitespace-pre-wrap break-words max-h-48 overflow-auto font-mono">
                                  {detailStr}
                                </pre>
                              </div>
                            )}
                            {/* 其他类型的详情 */}
                            {detailStr && logType !== 'tool' && (
                              <div className="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap break-words max-h-32 overflow-auto bg-muted/30 rounded p-1.5">
                                {detailStr}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setTimelineOpen(false)}
              className="niho-close-pink"
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ProcessStepsViewer;
