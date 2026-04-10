/**
 * MCP 详情遮罩层组件
 * 显示在消息上方，展示 MCP 执行详情（包括图片）
 */
import React, { useMemo } from 'react';
import { X, Image as ImageIcon, FileText, Terminal, Download, Maximize2, Copy, Check } from 'lucide-react';
import { MCPDetail } from '@/services/chat';
import { Button } from './ui/Button';
import { truncateBase64Strings } from '@/utils/textUtils';

interface MCPDetailOverlayProps {
  mcpDetail: MCPDetail;
  onClose: () => void;
}

export const MCPDetailOverlay: React.FC<MCPDetailOverlayProps> = ({ mcpDetail, onClose }) => {
  const [copied, setCopied] = React.useState(false);
  const [expandedImage, setExpandedImage] = React.useState<string | null>(null);

  // 解析 MCP 内容为有序块（图片/文本）
  type MCPContentBlock =
    | { kind: 'text'; text: string }
    | { kind: 'image'; mimeType: string; data: string }
    | { kind: 'video'; mimeType: string; data: string };

  const parseMCPContentBlocks = (rawContent: any): MCPContentBlock[] => {
    const blocks: MCPContentBlock[] = [];

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

      const sources = Array.isArray(contentObj) ? contentObj : [contentObj];

      for (const src of sources) {
        if (Array.isArray(src?.content)) {
          extractFromContentArray(src.content);
        } else if (Array.isArray(src?.result?.content)) {
          extractFromContentArray(src.result.content);
        } else if (Array.isArray(src?.results)) {
          for (const resultItem of src.results) {
            const nestedContent = resultItem?.result?.content || resultItem?.result?.result?.content;
            if (Array.isArray(nestedContent)) {
              extractFromContentArray(nestedContent);
            }
          }
        } else if (src?.jsonrpc && Array.isArray(src?.result?.content)) {
          extractFromContentArray(src.result.content);
        } else if (src && typeof src === 'object' && blocks.length === 0) {
          blocks.push({ kind: 'text', text: JSON.stringify(src, null, 2) });
        } else if (typeof src === 'string' && src.trim()) {
          blocks.push({ kind: 'text', text: src });
        }
      }
    } catch (e) {
      console.error('[MCPDetailOverlay] Failed to parse content:', e);
      blocks.push({
        kind: 'text',
        text: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent, null, 2),
      });
    }

    return blocks;
  };

  // 解析内容块
  const contentBlocks = useMemo(() => {
    if (mcpDetail.raw_result) {
      return parseMCPContentBlocks(mcpDetail.raw_result);
    }
    return [];
  }, [mcpDetail.raw_result]);

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

  // 复制原始数据
  const copyRawData = () => {
    const textToCopy = JSON.stringify(mcpDetail.raw_result, null, 2);
    navigator.clipboard.writeText(textToCopy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <>
      {/* 灰色遮罩层 */}
      <div
        className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* MCP 详情面板 */}
      <div className="fixed inset-4 z-50 bg-white dark:bg-[#2d2d2d] rounded-xl shadow-2xl border border-gray-200 dark:border-[#404040] overflow-hidden flex flex-col">
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-[#404040] flex items-center justify-between bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-md">
              <ImageIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="font-semibold text-gray-900 dark:text-white text-base">
                MCP 执行详情
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {mcpDetail.component_name || mcpDetail.component_id}
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-auto p-6 space-y-4">
          {/* 状态信息 */}
          <div className="flex items-center gap-3 text-sm">
            <span className="px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
              状态: {mcpDetail.status === 'completed' ? '已完成' : mcpDetail.status === 'error' ? '执行失败' : mcpDetail.status}
            </span>
            {stats.images.length > 0 && (
              <span className="px-2.5 py-1 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center gap-1">
                <ImageIcon className="w-3.5 h-3.5" />
                {stats.images.length} 张图片
              </span>
            )}
            {stats.texts.length > 0 && (
              <span className="px-2.5 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center gap-1">
                <FileText className="w-3.5 h-3.5" />
                {stats.texts.length} 段文本
              </span>
            )}
            {mcpDetail.logs && mcpDetail.logs.length > 0 && (
              <span className="px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 flex items-center gap-1">
                <Terminal className="w-3.5 h-3.5" />
                {mcpDetail.logs.length} 条日志
              </span>
            )}
          </div>

          {/* 错误信息 */}
          {mcpDetail.status === 'error' && mcpDetail.error_message && (
            <div className="p-4 bg-red-50 dark:bg-red-900/30 rounded-lg border border-red-200 dark:border-red-800">
              <div className="text-sm text-red-700 dark:text-red-300">
                {mcpDetail.error_message}
              </div>
            </div>
          )}

          {/* 图片展示 */}
          {stats.images.length > 0 && (
            <div className="space-y-3">
              <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                <ImageIcon className="w-4 h-4" />
                <span>返回图片</span>
              </div>
              <div className="grid gap-4" style={{ gridTemplateColumns: stats.images.length === 1 ? '1fr' : 'repeat(auto-fill, minmax(250px, 1fr))' }}>
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
                          className="w-full h-auto max-h-[500px] object-contain cursor-pointer hover:opacity-95 transition-opacity"
                          onClick={() => setExpandedImage(`data:${block.mimeType};base64,${block.data}`)}
                        />
                        <div className="absolute bottom-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => downloadImage(block.data, block.mimeType, idx)}
                            className="p-2 bg-black/70 hover:bg-black/90 text-white rounded-md transition-colors"
                            title="下载图片"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setExpandedImage(`data:${block.mimeType};base64,${block.data}`)}
                            className="p-2 bg-black/70 hover:bg-black/90 text-white rounded-md transition-colors"
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

          {/* 文本展示 */}
          {stats.texts.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  <span>返回文本</span>
                </div>
                <button
                  onClick={copyRawData}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? '已复制' : '复制'}</span>
                </button>
              </div>
              <div className="space-y-2">
                {stats.texts.map((block, idx) => {
                  if (block.kind !== 'text') return null;
                  let displayText = block.text;
                  let isJson = false;
                  try {
                    const parsed = JSON.parse(block.text);
                    displayText = JSON.stringify(parsed, null, 2);
                    isJson = true;
                  } catch {}

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

          {/* 执行日志 */}
          {mcpDetail.logs && mcpDetail.logs.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                <Terminal className="w-4 h-4" />
                <span>执行日志</span>
              </div>
              <div className="p-4 bg-gray-900 dark:bg-black rounded-lg max-h-64 overflow-auto border border-gray-700">
                <div className="font-mono text-xs text-green-400 space-y-0.5">
                  {mcpDetail.logs.map((log, idx) => (
                    <div key={idx} className="flex">
                      <span className="text-gray-500 mr-2 select-none">{idx + 1}</span>
                      <span>{log}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 原始数据 */}
          {mcpDetail.raw_result && (
            <div className="space-y-2">
              <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                <FileText className="w-4 h-4" />
                <span>原始数据</span>
              </div>
              <pre className="p-4 bg-gray-900 dark:bg-black rounded-lg text-xs text-gray-300 font-mono overflow-auto max-h-64 border border-gray-700">
                {truncateBase64Strings(JSON.stringify(mcpDetail.raw_result, null, 2))}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* 图片放大弹窗 */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-[60] bg-black/95 flex items-center justify-center p-4"
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
            <X className="w-6 h-6" />
          </button>
        </div>
      )}
    </>
  );
};

export default MCPDetailOverlay;

