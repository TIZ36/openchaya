/**
 * MCP 执行卡片组件
 * 专门用于展示 MCP 工具调用过程和结果（包括图片、文本等）
 */
import React, { useState, useEffect, useMemo } from 'react';
import {
  Plug,
  Play,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Trash2,
  Download,
  Maximize2,
  Copy,
  Check,
  Terminal,
  Image as ImageIcon,
  FileText,
  Clock,
  Zap,
} from 'lucide-react';
import { Button } from './ui/Button';
import { getMessageExecution, MessageExecution } from '@/services/chat';
import { truncateBase64Strings } from '@/utils/textUtils';

// MCP 内容块类型
type MCPContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; data: string }
  | { kind: 'video'; mimeType: string; data: string };

interface MCPExecutionCardProps {
  messageId: string;
  mcpServerName: string;
  mcpServerId: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  content?: string;
  inputText?: string;
  onExecute?: () => void;
  onDelete?: () => void;
}

export const MCPExecutionCard: React.FC<MCPExecutionCardProps> = ({
  messageId,
  mcpServerName,
  mcpServerId,
  status,
  content,
  inputText,
  onExecute,
  onDelete,
}) => {
  const [execution, setExecution] = useState<MessageExecution | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [showRawResult, setShowRawResult] = useState(true); // 默认展开原始数据
  const [copied, setCopied] = useState(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  // 加载执行记录
  useEffect(() => {
    if (status === 'completed' || status === 'error') {
      getMessageExecution(messageId).then(exec => {
        if (exec) {
          setExecution(exec);
        }
      }).catch(console.error);
    }
  }, [messageId, status]);

  // 解析 MCP 内容为有序块
  const parseMCPContentBlocks = (rawContent: any): MCPContentBlock[] => {
    const blocks: MCPContentBlock[] = [];

    // 辅助函数：从 content 数组提取块
    const extractFromContentArray = (contentArray: any[]) => {
      for (const item of contentArray) {
        if (item?.type === 'text' && typeof item.text === 'string') {
          blocks.push({ kind: 'text', text: item.text });
        } else if (item?.type === 'image' || item?.type === 'video') {
          const mimeType = item.mimeType || item.mime_type || 'image/png';
          const data = item.data;
          if (typeof data === 'string' && data.length > 0) {
            blocks.push({ kind: item.type, mimeType, data });
          }
        } else if (item !== undefined) {
          // 兜底
          blocks.push({ kind: 'text', text: JSON.stringify(item, null, 2) });
        }
      }
    };

    try {
      let contentObj = rawContent;
      if (typeof rawContent === 'string') {
        try {
          contentObj = JSON.parse(rawContent);
        } catch {
          return [{ kind: 'text', text: rawContent }];
        }
      }

      // 处理多种格式
      const sources = Array.isArray(contentObj) ? contentObj : [contentObj];

      for (const src of sources) {
        // 路径1: 直接 content 数组
        if (Array.isArray(src?.content)) {
          extractFromContentArray(src.content);
          continue;
        }

        // 路径2: result.content（MCP jsonrpc 响应）
        if (Array.isArray(src?.result?.content)) {
          extractFromContentArray(src.result.content);
          continue;
        }

        // 路径3: results[i].result.content（后端 raw_result 格式）
        // 后端格式: { results: [{ tool, result: { content: [...] } }] }
        if (Array.isArray(src?.results)) {
          for (const resultItem of src.results) {
            // MCP 返回格式可能是 result.content 或 result.result.content
            const nestedContent = resultItem?.result?.content || resultItem?.result?.result?.content;
            if (Array.isArray(nestedContent)) {
              extractFromContentArray(nestedContent);
            }
          }
          continue;
        }

        // 路径4: jsonrpc 响应格式
        if (src?.jsonrpc && Array.isArray(src?.result?.content)) {
          extractFromContentArray(src.result.content);
          continue;
        }

        // 如果以上都没匹配到，尝试把整个对象作为文本
        if (src && typeof src === 'object') {
          // 只在还没有解析到任何块时添加
          if (blocks.length === 0) {
            blocks.push({ kind: 'text', text: JSON.stringify(src, null, 2) });
          }
        } else if (typeof src === 'string' && src.trim()) {
          blocks.push({ kind: 'text', text: src });
        }
      }
    } catch (e) {
      console.error('[MCPExecutionCard] Failed to parse content:', e);
      blocks.push({
        kind: 'text',
        text: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent, null, 2),
      });
    }

    return blocks;
  };

  // 解析内容块
  const contentBlocks = useMemo(() => {
    // 优先从 execution.raw_result 解析（更完整的结构化数据）
    if (execution?.raw_result) {
      try {
        const rawResult = typeof execution.raw_result === 'string'
          ? JSON.parse(execution.raw_result)
          : execution.raw_result;
        return parseMCPContentBlocks(rawResult);
      } catch {
        // 解析失败则继续用 content
      }
    }
    // 回退到 message.content
    if (content) {
      return parseMCPContentBlocks(content);
    }
    return [];
  }, [execution?.raw_result, content]);

  // 解析日志
  const logs = useMemo(() => {
    if (execution?.logs) {
      try {
        const parsed = typeof execution.logs === 'string'
          ? JSON.parse(execution.logs)
          : execution.logs;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }, [execution?.logs]);

  // 图片和文本统计
  const stats = useMemo(() => {
    const images = contentBlocks.filter(b => b.kind === 'image');
    const videos = contentBlocks.filter(b => b.kind === 'video');
    const texts = contentBlocks.filter(b => b.kind === 'text');
    return { images, videos, texts };
  }, [contentBlocks]);

  // 下载图片
  const downloadImage = (data: string, mimeType: string, index: number) => {
    try {
      const ext = mimeType.split('/')[1] || 'png';
      const filename = `mcp-image-${Date.now()}-${index + 1}.${ext}`;
      const byteCharacters = atob(data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('下载图片失败:', error);
    }
  };

  // 复制结果（优先复制原始数据）
  const copyResult = () => {
    let textToCopy = '';
    
    // 优先使用 raw_result，其次使用 content
    const rawData = execution?.raw_result || content;
    if (rawData) {
      if (typeof rawData === 'string') {
        textToCopy = rawData;
      } else {
        textToCopy = JSON.stringify(rawData, null, 2);
      }
    } else if (stats.texts.length > 0) {
      // 回退到文本块
      textToCopy = stats.texts.map(t => t.text).join('\n');
    }
    
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  // 状态颜色和图标
  const statusConfig = {
    pending: {
      color: 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600',
      icon: <Clock className="w-4 h-4 text-gray-500" />,
      text: '待执行',
      textColor: 'text-gray-600 dark:text-gray-400',
    },
    running: {
      color: 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700',
      icon: <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />,
      text: '执行中',
      textColor: 'text-blue-600 dark:text-blue-400',
    },
    completed: {
      color: 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700',
      icon: <CheckCircle2 className="w-4 h-4 text-green-500" />,
      text: '执行成功',
      textColor: 'text-green-600 dark:text-green-400',
    },
    error: {
      color: 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700',
      icon: <XCircle className="w-4 h-4 text-red-500" />,
      text: '执行失败',
      textColor: 'text-red-600 dark:text-red-400',
    },
  };

  const currentStatus = statusConfig[status];

  return (
    <div className={`w-full rounded-xl border-2 ${currentStatus.color} overflow-hidden shadow-sm`}>
      {/* 头部 */}
      <div className="px-4 py-3 border-b border-inherit bg-white/50 dark:bg-black/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-md">
              <Plug className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="font-semibold text-gray-900 dark:text-white text-sm">
                {mcpServerName}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
                <span>MCP 服务器</span>
                <span className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-[10px] font-mono">
                  {mcpServerId.substring(0, 8)}...
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* 状态标签 */}
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${currentStatus.textColor} bg-white/80 dark:bg-black/30`}>
              {currentStatus.icon}
              <span>{currentStatus.text}</span>
            </div>
            {/* 删除按钮 */}
            {onDelete && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onDelete}
                className="h-8 w-8 text-gray-400 hover:text-red-500"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* 输入内容预览 */}
      {inputText && (
        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-inherit">
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1 flex items-center gap-1">
            <Zap className="w-3 h-3" />
            <span>输入指令</span>
          </div>
          <div className="text-sm text-gray-700 dark:text-gray-300 line-clamp-2">
            {inputText}
          </div>
        </div>
      )}

      {/* 执行按钮 */}
      {status === 'pending' && onExecute && (
        <div className="px-4 py-4">
          <Button
            variant="primary"
            onClick={onExecute}
            className="w-full flex items-center justify-center gap-2"
          >
            <Play className="w-4 h-4" />
            开始执行
          </Button>
        </div>
      )}

      {/* 执行中动画 */}
      {status === 'running' && (
        <div className="px-4 py-6">
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
              </div>
              <div className="absolute inset-0 rounded-full border-2 border-blue-300 dark:border-blue-700 animate-ping opacity-30" />
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              正在调用 MCP 服务器...
            </div>
          </div>
        </div>
      )}

      {/* 执行结果 */}
      {(status === 'completed' || status === 'error') && (
        <div className="px-4 py-3 space-y-3">
          {/* 错误信息 */}
          {status === 'error' && execution?.error_message && (
            <div className="p-3 bg-red-100 dark:bg-red-900/30 rounded-lg border border-red-200 dark:border-red-800">
              <div className="text-sm text-red-700 dark:text-red-300">
                {execution.error_message}
              </div>
            </div>
          )}

          {/* 结果统计 */}
          {status === 'completed' && (
            <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
              {contentBlocks.length > 0 && (
                <>
                  {stats.images.length > 0 && (
                    <div className="flex items-center gap-1 px-2 py-1 bg-purple-100 dark:bg-purple-900/30 rounded text-purple-600 dark:text-purple-400">
                      <ImageIcon className="w-3.5 h-3.5" />
                      <span>{stats.images.length} 张图片</span>
                    </div>
                  )}
                  {stats.texts.length > 0 && (
                    <div className="flex items-center gap-1 px-2 py-1 bg-blue-100 dark:bg-blue-900/30 rounded text-blue-600 dark:text-blue-400">
                      <FileText className="w-3.5 h-3.5" />
                      <span>{stats.texts.length} 段文本</span>
                    </div>
                  )}
                </>
              )}
              {logs.length > 0 && (
                <button
                  onClick={() => setShowLogs(!showLogs)}
                  className="flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                >
                  <Terminal className="w-3.5 h-3.5" />
                  <span>{logs.length} 条日志</span>
                  {showLogs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
              )}
              {/* 原始数据按钮 */}
              {(execution?.raw_result || content) && (
                <button
                  onClick={() => setShowRawResult(!showRawResult)}
                  className="flex items-center gap-1 px-2 py-1 bg-orange-100 dark:bg-orange-900/30 rounded text-orange-600 dark:text-orange-400 hover:bg-orange-200 dark:hover:bg-orange-800 transition-colors"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>原始数据</span>
                  {showRawResult ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
              )}
            </div>
          )}

          {/* 日志展示 */}
          {showLogs && logs.length > 0 && (
            <div className="p-3 bg-gray-900 dark:bg-black rounded-lg max-h-48 overflow-auto">
              <div className="font-mono text-xs text-green-400 space-y-0.5">
                {logs.map((log, idx) => (
                  <div key={idx} className="flex">
                    <span className="text-gray-500 mr-2 select-none">{idx + 1}</span>
                    <span>{log}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 图片结果 */}
          {stats.images.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-600 dark:text-gray-400">
                返回图片
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: stats.images.length === 1 ? '1fr' : 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                {stats.images.map((block, idx) => (
                  <div
                    key={`img-${idx}`}
                    className="relative group rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800"
                  >
                    {block.kind === 'image' && (
                      <>
                        <img
                          src={`data:${block.mimeType};base64,${block.data}`}
                          alt={`MCP 返回图片 ${idx + 1}`}
                          className="w-full h-auto max-h-[400px] object-contain cursor-pointer hover:opacity-95 transition-opacity"
                          onClick={() => setExpandedImage(`data:${block.mimeType};base64,${block.data}`)}
                        />
                        {/* 悬浮操作 */}
                        <div className="absolute bottom-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => downloadImage(block.data, block.mimeType, idx)}
                            className="p-1.5 bg-black/70 hover:bg-black/90 text-white rounded-md transition-colors"
                            title="下载图片"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setExpandedImage(`data:${block.mimeType};base64,${block.data}`)}
                            className="p-1.5 bg-black/70 hover:bg-black/90 text-white rounded-md transition-colors"
                            title="放大查看"
                          >
                            <Maximize2 className="w-4 h-4" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 文本结果 */}
          {stats.texts.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  返回文本
                </div>
                <button
                  onClick={copyResult}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? '已复制' : '复制'}</span>
                </button>
              </div>
              <div className="space-y-2">
                {stats.texts.map((block, idx) => {
                  if (block.kind !== 'text') return null;
                  // 尝试美化 JSON
                  let displayText = block.text;
                  let isJson = false;
                  try {
                    const parsed = JSON.parse(block.text);
                    displayText = JSON.stringify(parsed, null, 2);
                    isJson = true;
                  } catch {
                    // 不是 JSON
                  }
                  // 省略 base64 字符串
                  displayText = truncateBase64Strings(displayText);

                  return (
                    <div
                      key={`text-${idx}`}
                      className={`p-3 rounded-lg border ${
                        isJson
                          ? 'bg-gray-900 dark:bg-black border-gray-700 font-mono text-xs text-gray-300'
                          : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300'
                      } overflow-auto max-h-64 whitespace-pre-wrap break-words`}
                    >
                      {displayText}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 原始数据展示（优先显示，即使解析失败也要显示） */}
          {showRawResult && (execution?.raw_result || content) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5" />
                  <span>MCP 原始返回数据</span>
                </div>
                <button
                  onClick={copyResult}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? '已复制' : '复制'}</span>
                </button>
              </div>
              <pre className="p-3 bg-gray-900 dark:bg-black rounded-lg text-xs text-gray-300 font-mono overflow-auto max-h-96 border border-gray-700 dark:border-gray-800">
                {(() => {
                  // 优先使用 raw_result，其次使用 content
                  const rawData = execution?.raw_result || content;
                  if (!rawData) return '暂无数据';
                  
                  let displayText: string;
                  if (typeof rawData === 'string') {
                    try {
                      // 尝试解析为 JSON 并美化
                      const parsed = JSON.parse(rawData);
                      displayText = JSON.stringify(parsed, null, 2);
                    } catch {
                      // 不是 JSON，直接显示
                      displayText = rawData;
                    }
                  } else {
                    // 对象直接序列化
                    displayText = JSON.stringify(rawData, null, 2);
                  }
                  // 省略 base64 字符串
                  return truncateBase64Strings(displayText);
                })()}
              </pre>
            </div>
          )}

          {/* 如果没有解析到任何内容块，提示用户查看原始数据 */}
          {status === 'completed' && contentBlocks.length === 0 && !showRawResult && (
            <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
              <div className="text-xs text-yellow-700 dark:text-yellow-300">
                ⚠️ 未能解析出图片或文本内容，请查看上方的"原始数据"区域
              </div>
            </div>
          )}
        </div>
      )}

      {/* 图片放大弹窗 */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setExpandedImage(null)}
        >
          <img
            src={expandedImage}
            alt="放大预览"
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setExpandedImage(null)}
            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
          >
            <XCircle className="w-6 h-6" />
          </button>
        </div>
      )}
    </div>
  );
};

export default MCPExecutionCard;

