/**
 * MessageContent Component
 * 
 * Renders the content of a message in the workflow chat,
 * handling various message types including:
 * - Thinking/streaming placeholders
 * - Error messages
 * - Media content (images, video, audio)
 * - Tool messages (MCP, Workflow)
 * - Assistant messages with Markdown
 * - User messages
 */

import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertCircle,
  CheckCircle,
  Workflow as WorkflowIcon,
  Play,
  ArrowRight,
  Trash2,
  Wrench,
  FileText,
} from 'lucide-react';
import { MediaGallery, MediaItem } from '../ui/MediaGallery';
import { MCPExecutionCard } from '../MCPExecutionCard';
import { Button } from '../ui/Button';
import { AudioPlayer } from '../AudioPlayer';
import { truncateBase64Strings } from '../../utils/textUtils';
import { parseMCPContentBlocks, renderMCPBlocks, renderMCPMedia } from './mcpRender';
import type { SessionMediaItem } from '../ui/SessionMediaPanel';
import { ExecutionLogViewer, type ExecutionLogEntry } from '../ui/ExecutionLogViewer';
import type { Message } from './types';

export interface MessageContentProps {
  /** The message to render */
  message: Message;
  /** Previous message content (for context display, optimized to avoid passing entire messages array) */
  prevMessageContent?: string;
  /** Abort controller for canceling generation */
  abortController: AbortController | null;
  /** Setter for abort controller */
  setAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>;
  /** Setter for messages */
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /** Setter for loading state */
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  /** Set of collapsed thinking message IDs */
  collapsedThinking: Set<string>;
  /** Toggle thinking collapse for a message */
  toggleThinkingCollapse: (messageId: string) => void;
  /** Handler for executing workflow */
  handleExecuteWorkflow: (messageId: string) => void;
  /** Handler for deleting workflow message */
  handleDeleteWorkflowMessage: (messageId: string) => void;
  /** Open single media viewer (only show one item) */
  openSingleMediaViewer: (item: SessionMediaItem) => void;
}

/**
 * Parse MCP content to extract texts and media
 */
const parseMCPContent = (content: any): { 
  texts: string[]; 
  media: Array<{ type: 'image' | 'video' | 'audio'; mimeType: string; data: string }> 
} => {
  const texts: string[] = [];
  const media: Array<{ type: 'image' | 'video' | 'audio'; mimeType: string; data: string }> = [];

  const inferMimeTypeFromUrl = (url: string, fallback: string) => {
    const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|#|$)/);
    if (!match) return fallback;
    const ext = match[1].toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'mp4') return 'video/mp4';
    if (ext === 'webm') return 'video/webm';
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'wav') return 'audio/wav';
    return fallback;
  };
  
  try {
    let contentObj = content;
    if (typeof content === 'string') {
      try {
        contentObj = JSON.parse(content);
      } catch {
        return { texts: [content], media: [] };
      }
    }
    
    const contentArray = contentObj?.result?.content || contentObj?.content || (Array.isArray(contentObj) ? contentObj : null);
    
    if (Array.isArray(contentArray)) {
      for (const item of contentArray) {
        if (item.type === 'text' && item.text) {
          texts.push(item.text);
        } else if (item.type === 'image' || item.type === 'video' || item.type === 'audio') {
          const rawMimeType = item.mimeType || item.mime_type;
          const rawData = item.data || item.url || item.image_url || item.imageUrl;
          const fallback = item.type === 'image'
            ? 'image/png'
            : item.type === 'video'
              ? 'video/mp4'
              : 'audio/mpeg';
          const mimeType =
            typeof rawMimeType === 'string' && rawMimeType.length > 0
              ? rawMimeType
              : typeof rawData === 'string'
                ? inferMimeTypeFromUrl(rawData, fallback)
                : fallback;
          const data = typeof rawData === 'string' ? rawData : '';
          if (!data) {
            console.warn('[MCP Debug] parseMCPContent media missing data, skipping');
            continue;
          }
          media.push({ type: item.type, mimeType, data });
        }
      }
    } else if (contentObj && typeof contentObj === 'object') {
      texts.push(JSON.stringify(contentObj, null, 2));
    }
  } catch (e) {
    console.error('[MCP Debug] parseMCPContent parsing failed:', e);
    texts.push(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  
  return { texts, media };
};

/**
 * MessageContent component
 * Renders the content of a message based on its type and state
 */
const MessageContentInner: React.FC<MessageContentProps> = ({
  message,
  prevMessageContent,
  abortController,
  setAbortController,
  setMessages,
  setIsLoading,
  collapsedThinking: _collapsedThinking, // Kept for API compatibility, thinking is shown in MessageSidePanel
  toggleThinkingCollapse: _toggleThinkingCollapse, // Kept for API compatibility
  handleExecuteWorkflow,
  handleDeleteWorkflowMessage,
  openSingleMediaViewer,
}) => {
  const galleryMedia = useMemo<MediaItem[] | null>(() => {
    const list = message.media;
    if (!list || list.length === 0) return null;
    // 保持引用稳定：避免父级因输入重渲染时，每次都创建新数组触发 MediaGallery 的 preload effect
    return list.map(m => {
      // UnifiedMedia 只有 url 字段，MediaItem 需要 data 和 url
      // 如果 url 是 data URL，提取 base64 数据；否则保持原样
      let data = m.data;
      let url = m.url;
      
      // 如果 url 是 data URL，提取 base64 部分作为 data
      if (url && url.startsWith('data:')) {
        const commaIdx = url.indexOf(',');
        if (commaIdx >= 0) {
          data = url.slice(commaIdx + 1); // 提取 base64 部分
        }
      } else if (url && !data) {
        // 如果只有 url 没有 data，且 url 不是 data URL，将 url 作为 data（兼容旧数据）
        data = url;
      }
      
      return {
        type: m.type,
        mimeType: m.mimeType || (m.type === 'image' ? 'image/png' : m.type === 'video' ? 'video/mp4' : 'audio/mpeg'),
        data: data || url || '', // 确保有 data
        url: url || data, // 确保有 url
      };
    });
  }, [message.media]);

  // Helper function to render MCP blocks for a message
  const renderMCPBlocksForMessage = (blocks: any[], messageId?: string) => {
    return renderMCPBlocks({
      blocks,
      messageId,
      openSingleMediaViewer,
    });
  };

  // Helper function to render MCP media for a message
  const renderMCPMediaForMessage = (
    media: Array<{ type: 'image' | 'video' | 'audio'; mimeType: string; data: string }>,
    messageId?: string
  ) => {
    return renderMCPMedia({
      media,
      messageId,
      openSingleMediaViewer,
    });
  };

  // Thinking/generating placeholder (when content is empty and processing)
  // 执行过程已由外层日志流展示，这里不再显示转圈占位，避免重复。
  if (message.role === 'assistant' && (!message.content || message.content.length === 0) && (message.isThinking || message.isStreaming)) {
    return null;
  }
  
  // Error message (with special styling)
  if (message.role === 'assistant' && message.content?.includes('❌ 错误')) {
    return (
      <div className="w-full">
        <div className="rounded-lg border border-[var(--color-secondary)]/28 bg-[var(--color-secondary-bg)] p-4">
          <div className="flex items-start space-x-3">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--color-secondary)]" />
            <div className="flex-1">
              <div className="whitespace-pre-wrap text-sm text-[var(--text-primary)]">
                {message.content}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  
  // Media content display (images, video, audio) - using thumbnail gallery
  const renderMedia = () => {
    if (!galleryMedia || galleryMedia.length === 0) {
      return null;
    }
    
    return (
      <div className="mb-3">
        <MediaGallery 
          media={galleryMedia} 
          thumbnailSize="md"
          maxVisible={6}
          showDownload={true}
          onOpenSessionGallery={(index) => {
            const picked = galleryMedia[index];
            if (!picked) return;
            const item: SessionMediaItem = {
              type: picked.type,
              mimeType: picked.mimeType,
              data: picked.data,
              url: picked.url,
              messageId: message.id,
              role: message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : 'tool',
            };
            openSingleMediaViewer(item);
          }}
        />
      </div>
    );
  };

  // Render audio players for TTS-generated audio
  const renderAudioPlayers = () => {
    if (!galleryMedia || message.role !== 'assistant') {
      return null;
    }

    const audioItems = galleryMedia.filter(m => m.type === 'audio');
    if (audioItems.length === 0) {
      return null;
    }

    return (
      <div className="mb-3 flex flex-col gap-2">
        {audioItems.map((item, idx) => {
          // Convert data URL or base64 to Blob
          let audioBlob: Blob;
          try {
            if (item.data.startsWith('data:')) {
              const [header, data] = item.data.split(',');
              const binaryString = atob(data);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              audioBlob = new Blob([bytes], { type: item.mimeType });
            } else {
              const binaryString = atob(item.data);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              audioBlob = new Blob([bytes], { type: item.mimeType });
            }
          } catch (err) {
            console.error('Failed to decode audio data:', err);
            return null;
          }

          return (
            <AudioPlayer 
              key={`audio-${message.id}-${idx}`}
              audioBlob={audioBlob}
              autoPlay={false}
              className="mb-2"
            />
          );
        })}
      </div>
    );
  };
  
  // Tool message (perception component)
  if (message.role === 'tool' && message.toolType) {
    // MCP message uses dedicated MCPExecutionCard component
    if (message.toolType === 'mcp') {
      return (
        <MCPExecutionCard
          messageId={message.id}
          mcpServerName={message.workflowName || 'MCP 服务器'}
          mcpServerId={message.workflowId || ''}
          status={message.workflowStatus || 'pending'}
          content={message.content}
          inputText={prevMessageContent || ''}
          onExecute={() => handleExecuteWorkflow(message.id)}
          onDelete={() => handleDeleteWorkflowMessage(message.id)}
        />
      );
    }

    // 工作流功能已移除，不再支持工作流消息
    return null;
  }
  
  // Tool message (not perception component) - check if content contains MCP media
  if (message.role === 'tool' && !message.toolType && message.content && !message.toolCalls) {
    const parsed = parseMCPContent(message.content);
    const hasMedia = parsed.media.length > 0;
    
    if (hasMedia) {
      return (
        <div>
          <div className="font-medium text-sm mb-2 flex items-center gap-2">
            <Wrench className="w-4 h-4 text-green-500" />
            MCP 工具结果
          </div>
          {/* Render media content */}
          {renderMCPMediaForMessage(parsed.media, message.id)}
          {/* Render text content */}
          {parsed.texts.length > 0 && (
            <div className="mt-2 text-xs text-[var(--text-secondary)]">
              <pre className="max-h-64 overflow-auto rounded border border-[var(--border-default)] bg-[var(--surface-secondary)] p-2 text-xs text-[var(--text-primary)]">
                {parsed.texts.join('\n')}
              </pre>
            </div>
          )}
        </div>
      );
    }
  }
  
  // Regular tool call message (not perception component)
  // 隐藏工具调用的详细信息，只显示错误信息（如果有）
  if (message.role === 'tool' && message.toolCalls && !message.toolType) {
    // 检查是否有错误
    const hasError = Array.isArray(message.toolCalls) && message.toolCalls.some(
      (tc: any) => tc.error || (tc.result && typeof tc.result === 'object' && tc.result.error)
    );
    
    // 如果有错误，显示错误信息；否则不显示工具调用详情
    if (hasError) {
      return (
        <div>
          <div className="mb-2 text-sm font-medium text-[var(--color-secondary)]">工具调用错误:</div>
          {Array.isArray(message.toolCalls) && message.toolCalls.map((toolCall: any, idx: number) => {
            const error = toolCall.error || (toolCall.result && typeof toolCall.result === 'object' && toolCall.result.error);
            if (!error) return null;
            
            return (
              <div key={idx} className="mb-3 rounded-lg border border-[var(--color-secondary)]/28 bg-[var(--color-secondary-bg)] p-3">
                <div className="flex items-center space-x-2 mb-2">
                  <Wrench className="h-4 w-4 text-[var(--color-secondary)]" />
                  <span className="text-sm font-medium text-[var(--color-secondary)]">{toolCall.name}</span>
                </div>
                <div className="text-sm text-[var(--text-primary)]">
                  {typeof error === 'string' ? error : JSON.stringify(error, null, 2)}
                </div>
              </div>
            );
          })}
        </div>
      );
    }
    
    // 没有错误，不显示工具调用详情（隐藏）
    return null;
  }

  // Note: Thinking and MCP details are shown in MessageSidePanel (above message bubble).
  // We don't render them here in MessageContent to avoid duplication.
  // The collapsedThinking and toggleThinkingCollapse props are kept for API compatibility
  // but not used here since thinking is now only displayed in the side panel.

  return (
    <div>
      {/* Multimodal content display */}
      {renderMedia()}

      {/* Audio players for TTS-generated speech */}
      {renderAudioPlayers()}

      {/* Reactions (decorations) - e.g. likes */}
      {(() => {
        const likes = message?.ext?.reactions?.likes;
        if (!Array.isArray(likes) || likes.length === 0) return null;
        const title = likes
          .map((l: any) => l?.from_agent_name || l?.from_agent_id)
          .filter(Boolean)
          .join('、');
        return (
            <div
              className="mt-1 inline-flex items-center gap-1 rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]"
              title={title ? `点赞：${title}` : '点赞'}
            >
            <span aria-hidden>👍</span>
            <span>{likes.length}</span>
          </div>
        );
      })()}
      
      {/* AI assistant messages use Markdown rendering */}
      {message.role === 'assistant' ? (
        (() => {
          // 预处理：提取嵌入在 Markdown 中的 base64 图片
          // ReactMarkdown 对超长 data URL 解析有问题，需要单独处理
          const extractEmbeddedImages = (content: string): { 
            cleanContent: string; 
            images: Array<{ alt: string; dataUrl: string }> 
          } => {
            if (!content) return { cleanContent: '', images: [] };
            
            const images: Array<{ alt: string; dataUrl: string }> = [];
            
            // 匹配 Markdown 图片语法中的 data URL: ![alt](data:image/xxx;base64,...)
            const imageRegex = /!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)/g;
            
            let match;
            while ((match = imageRegex.exec(content)) !== null) {
              const dataUrl = match[2];
              // 只提取大于 10KB 的图片（小图片让 ReactMarkdown 处理）
              if (dataUrl.length > 10000) {
                images.push({
                  alt: match[1] || '生成的图片',
                  dataUrl: dataUrl
                });
              }
            }
            
            // 从内容中移除已提取的大图片
            let cleanContent = content;
            if (images.length > 0) {
              cleanContent = content.replace(
                /!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]{10000,})\)/g,
                '' // 移除大图片的 Markdown 语法
              ).trim();
              console.log('[MessageContent] Extracted', images.length, 'embedded images from content');
            }
            
            return { cleanContent, images };
          };
          
          const { cleanContent: rawContent, images: embeddedImages } = extractEmbeddedImages(message.content || '');
          const sanitizeThinkTags = (content: string) => {
            if (!content) return '';
            // Remove <think>...</think> blocks (case-insensitive, dotall)
            const withoutBlocks = content.replace(/<think[\s\S]*?>[\s\S]*?<\/think>/gi, '');
            // Remove any stray think tags
            return withoutBlocks.replace(/<\/?think[^>]*>/gi, '').trim();
          };
          const cleanContent = sanitizeThinkTags(rawContent);
          
          return (
            <div className="markdown-content max-w-none text-[var(--text-primary)] [&>:first-child]:mt-0">
              {/* 渲染提取出的嵌入图片 */}
              {embeddedImages.length > 0 && (
                <div className="mb-3 space-y-3">
                  {embeddedImages.map((img, idx) => (
                    <div key={idx} className="not-prose">
                      <img
                        src={img.dataUrl}
                        alt={img.alt}
                        loading="lazy"
                        className="h-auto max-w-full cursor-pointer rounded-lg border border-[var(--border-default)] transition-opacity hover:opacity-90"
                        style={{ maxHeight: '400px', objectFit: 'contain' }}
                        onClick={() => {
                          const win = window.open('', '_blank');
                          if (win) {
                            win.document.write(`
                              <html>
                                <head><title>${img.alt}</title></head>
                                <body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#000">
                                  <img src="${img.dataUrl}" style="max-width:100%;max-height:100vh;object-fit:contain;" alt="${img.alt}" />
                                </body>
                              </html>
                            `);
                          }
                        }}
                        onError={(e) => {
                          console.error('[MessageContent] Failed to load embedded image:', idx);
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                      {img.alt && img.alt !== '生成的图片' && (
                        <p className="mt-1 text-center text-xs text-[var(--text-muted)]">{img.alt}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              
              {/* 渲染剩余的 Markdown 内容 */}
              {cleanContent && (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
              // Code block styling
              code: ({ node, inline, className, children, ...props }: any) => {
                const match = /language-(\w+)/.exec(className || '');
                const language = match ? match[1] : '';
                
                if (!inline && match) {
                  // Code block - use independent component to handle copy state
                  const codeText = String(children).replace(/\n$/, '');
                  const CodeBlock = () => {
                    const [copied, setCopied] = useState(false);
                    
                    return (
                      <div className="relative group my-2">
                        {/* Language label */}
                        {language && (
                          <div className="absolute top-1.5 left-2 z-10 rounded bg-[var(--surface-overlay)] px-2 py-0.5 font-mono text-xs text-[var(--text-muted)]">
                            {language}
                          </div>
                        )}
                        <pre className="overflow-x-auto rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3 pt-7 text-[var(--text-primary)]">
                          <code className={className} {...props}>
                            {children}
                          </code>
                        </pre>
                        <Button
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(codeText);
                              setCopied(true);
                              setTimeout(() => setCopied(false), 2000);
                            } catch (err) {
                              console.error('Failed to copy:', err);
                            }
                          }}
                          variant="ghost"
                          size="sm"
                          className="absolute top-2 right-2 z-10 bg-[var(--surface-overlay)] text-[var(--text-secondary)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--surface-elevated)] hover:text-[var(--text-primary)]"
                          title="复制代码"
                        >
                          {copied ? (
                            <>
                              <CheckCircle className="w-3 h-3" />
                              <span>已复制</span>
                            </>
                          ) : (
                            <>
                              <FileText className="w-3 h-3" />
                              <span>复制</span>
                            </>
                          )}
                        </Button>
                      </div>
                    );
                  };
                  
                  return <CodeBlock />;
                } else {
                  // Inline code
                  return (
                    <code className="rounded bg-[var(--surface-elevated)] px-1.5 py-0.5 font-mono text-sm text-[var(--text-primary)]" {...props}>
                      {children}
                    </code>
                  );
                }
              },
              // Paragraph styling - 确保第一个段落顶部对齐
              p: ({ children }: any) => <p className="mb-2 last:mb-0 first:mt-0 leading-snug">{children}</p>,
              // Heading styling
              h1: ({ children }: any) => <h1 className="text-xl font-bold mt-3 mb-2 first:mt-0">{children}</h1>,
              h2: ({ children }: any) => <h2 className="text-lg font-bold mt-3 mb-2 first:mt-0">{children}</h2>,
              h3: ({ children }: any) => <h3 className="text-base font-bold mt-2 mb-1.5 first:mt-0">{children}</h3>,
              // List styling
              ul: ({ children }: any) => <ul className="list-disc list-inside mb-2 space-y-0.5 ml-3">{children}</ul>,
              ol: ({ children }: any) => <ol className="list-decimal list-inside mb-2 space-y-0.5 ml-3">{children}</ol>,
              li: ({ children }: any) => <li className="leading-snug">{children}</li>,
              // Blockquote styling
              blockquote: ({ children }: any) => (
                <blockquote className="my-2 border-l-4 border-[var(--color-accent)] pl-3 italic text-[var(--text-secondary)]">
                  {children}
                </blockquote>
              ),
              // Link styling
              a: ({ href, children }: any) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                    className="text-[var(--color-accent)] hover:underline"
                >
                  {children}
                </a>
              ),
              // Table styling
              table: ({ children }: any) => (
                <div className="overflow-x-auto my-2">
                  <table className="min-w-full border-collapse border border-[var(--border-default)] bg-[var(--surface-secondary)]">
                    {children}
                  </table>
                </div>
              ),
              thead: ({ children }: any) => (
                <thead className="bg-[var(--surface-elevated)]">{children}</thead>
              ),
              tbody: ({ children }: any) => <tbody>{children}</tbody>,
              tr: ({ children }: any) => (
                <tr className="border-b border-[var(--border-default)]">{children}</tr>
              ),
              th: ({ children }: any) => (
                <th className="border border-[var(--border-default)] px-2 py-1.5 text-left font-semibold text-[var(--text-primary)]">
                  {children}
                </th>
              ),
              td: ({ children }: any) => (
                <td className="border border-[var(--border-default)] px-2 py-1.5 text-[var(--text-primary)]">
                  {children}
                </td>
              ),
              // Horizontal rule
              hr: () => <hr className="my-3 border-[var(--border-default)]" />,
              // Emphasis styling
              strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
              em: ({ children }: any) => <em className="italic">{children}</em>,
              // Image styling - use independent component to handle state
              img: ({ src, alt, ...props }: any) => {
                // 调试日志
                console.log('[MessageContent] img component called:', {
                  hasSrc: !!src,
                  srcLength: src?.length || 0,
                  srcPreview: src?.substring(0, 100),
                  alt
                });
                
                // If no src, don't render
                if (!src) return null;
                
                // Helper function: detect if it's base64 data
                const looksLikeBase64Payload = (s: string): boolean => {
                  if (!s) return false;
                  const trimmed = s.trim();
                  // Already a data URL
                  if (trimmed.startsWith('data:')) return true;
                  // Too short, avoid misjudging normal paths
                  if (trimmed.length < 256) return false;
                  // Base64 charset (allowing padding)
                  return /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed);
                };
                
                // Helper function: infer image MIME type
                const inferImageMime = (payload: string): string => {
                  const base64 = payload.startsWith('data:') ? payload.slice(payload.indexOf(',') + 1) : payload.trim();
                  if (base64.startsWith('iVBORw')) return 'image/png';
                  if (base64.startsWith('/9j/') || base64.startsWith('9j/')) return 'image/jpeg';
                  if (base64.startsWith('R0lGOD')) return 'image/gif';
                  if (base64.startsWith('UklGR')) return 'image/webp';
                  return 'image/jpeg'; // Default JPEG
                };
                
                // Process image URL
                let imageSrc = src;
                
                // 1. Already a complete URL (http/https/data/blob/file), use directly
                if (/^(https?:|data:|blob:|file:)/i.test(src)) {
                  imageSrc = src;
                }
                // 2. Detect if it's base64 data (including JPEG base64 starting with /9j/)
                else if (looksLikeBase64Payload(src)) {
                  const mime = inferImageMime(src);
                  imageSrc = `data:${mime};base64,${src.trim()}`;
                }
                // 3. Backend relative path (starting with / but not //)
                else if (src.startsWith('/') && !src.startsWith('//')) {
                  const backendUrl = (window as any).__cachedBackendUrl || 'http://localhost:3001';
                  imageSrc = `${backendUrl}${src}`;
                }
                
                // Simple image rendering - no loading state to avoid UI complexity
                return (
                  <img
                    src={imageSrc}
                    alt={alt || '图片'}
                    loading="lazy"
                    className="my-3 h-auto max-w-full cursor-pointer rounded-lg border border-[var(--border-default)] transition-opacity hover:opacity-90"
                    style={{ maxHeight: '400px', objectFit: 'contain' }}
                    onClick={() => {
                      // Click image to preview in new window
                      const win = window.open('', '_blank');
                      if (win) {
                        win.document.write(`
                          <html>
                            <head><title>${alt || '图片预览'}</title></head>
                            <body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#000">
                              <img src="${imageSrc}" style="max-width:100%;max-height:100vh;object-fit:contain;" alt="${alt || '图片'}" />
                            </body>
                          </html>
                        `);
                      }
                    }}
                    {...props}
                  />
                );
              },
            }}
                  >
                    {cleanContent}
                  </ReactMarkdown>
              )}
            </div>
          );
        })()
      ) : (
        <div className="whitespace-pre-wrap break-words text-[var(--chat-message-font-size,12px)] leading-[var(--chat-message-line-height,1.5)] text-[var(--text-primary)]">
          {message.content}
        </div>
      )}
      
      {/* Execution Logs：assistant 且含过程信息时由思维链图标右侧 ExecutionLogScroller 统一展示，此处不再重复 */}
      {(() => {
        const hasProcessInfo =
          message.role === 'assistant' &&
          (!!(message.processMessages && message.processMessages.length > 0) ||
            !!((message.ext as any)?.processSteps && (message.ext as any).processSteps.length > 0) ||
            !!((message.ext as any)?.log && Array.isArray((message.ext as any).log) && (message.ext as any).log.length > 0) ||
            !!(message.thinking && message.thinking.trim().length > 0));
        if (hasProcessInfo) return null;
        const msgExecutionLogs = (message.ext as any)?.log || message.executionLogs || (message.ext as any)?.executionLogs;
        if (msgExecutionLogs && Array.isArray(msgExecutionLogs) && msgExecutionLogs.length > 0) {
          return (
            <div className="mt-2 px-2 py-1">
              <ExecutionLogViewer
                logs={msgExecutionLogs.map((log: any) => ({
                  ...log,
                  type: (log.type === 'tool' || log.type === 'thinking' || log.type === 'error' || log.type === 'success' || log.type === 'info' || log.type === 'step' || log.type === 'llm') 
                    ? log.type 
                    : 'info' as const
                }))}
                isActive={false}
                maxHeight={80}
                collapsed={true}
              />
            </div>
          );
        }
        return null;
      })()}
      
      {/* Process Steps / 执行轨迹：仅在 SplitViewMessage 首行（头像右侧）展示，不在此处重复，避免出现在输出框下方 */}
    </div>
  );
};


/**
 * Custom comparison function for React.memo
 * Prevents unnecessary re-renders by comparing only the relevant props
 */
const arePropsEqual = (
  prevProps: MessageContentProps,
  nextProps: MessageContentProps
): boolean => {
  // Compare message by reference first (fast path)
  if (prevProps.message === nextProps.message) {
    // If message is the same, check other props that might change
    return (
      prevProps.prevMessageContent === nextProps.prevMessageContent &&
      prevProps.collapsedThinking === nextProps.collapsedThinking
    );
  }
  
  // If message reference changed, compare key fields that affect rendering
  const pm = prevProps.message;
  const nm = nextProps.message;
  
  return (
    pm.id === nm.id &&
    pm.content === nm.content &&
    pm.role === nm.role &&
    pm.sender_id === nm.sender_id &&
    pm.sender_type === nm.sender_type &&
    pm.thinking === nm.thinking &&
    pm.isStreaming === nm.isStreaming &&
    pm.isThinking === nm.isThinking &&
    pm.currentStep === nm.currentStep &&
    pm.workflowStatus === nm.workflowStatus &&
    pm.media === nm.media &&
    pm.ext === nm.ext &&
    prevProps.prevMessageContent === nextProps.prevMessageContent &&
    prevProps.collapsedThinking === nextProps.collapsedThinking
  );
};

/**
 * Memoized MessageContent component
 * Prevents unnecessary re-renders when parent component updates
 */
export const MessageContent = React.memo(MessageContentInner, arePropsEqual);

export default MessageContent;
