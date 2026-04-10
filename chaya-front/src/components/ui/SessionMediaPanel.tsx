import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, Play, Music, Copy, Check, ChevronUp, ChevronDown, Image as ImageIcon } from 'lucide-react';
import { dataUrlToBlob, ensureDataUrlFromMaybeBase64 } from '../../utils/dataUrl';
import { resolveMediaSrc } from '@/utils/mediaSrc';
import { preloadImage } from '@/utils/mediaPreload';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

export interface SessionMediaItem {
  type: 'image' | 'video' | 'audio';
  mimeType: string;
  data: string;
  url?: string;
  /** 来源消息ID */
  messageId?: string;
  /** 来源消息角色 */
  role?: 'user' | 'assistant' | 'tool';
  /** 时间戳 */
  timestamp?: number;
}

interface SessionMediaPanelProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 会话中的所有媒体 */
  media: SessionMediaItem[];
  /** 初始选中的索引 */
  initialIndex?: number;
  /** 是否只显示图片 */
  imagesOnly?: boolean;
}

/**
 * 会话媒体面板 - 从右侧滑出，显示整个会话的所有媒体
 */
export const SessionMediaPanel: React.FC<SessionMediaPanelProps> = ({
  open,
  onClose,
  media,
  initialIndex = 0,
  imagesOnly = false,
}) => {
  // ============ 所有 hooks 必须在任何条件返回之前调用 ============
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [copied, setCopied] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
  const [isSelecting, setIsSelecting] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VirtuosoHandle>(null);

  // 过滤媒体
  const filteredMedia = imagesOnly ? media.filter(m => m.type === 'image') : media;

  // 重置索引当打开时
  useEffect(() => {
    if (open) {
      setCurrentIndex(Math.min(initialIndex, filteredMedia.length - 1));
      setSelectedItems(new Set());
      setIsSelecting(false);
    }
  }, [open, initialIndex, filteredMedia.length]);

  // 键盘导航
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowUp') goToPrevious();
      if (e.key === 'ArrowDown') goToNext();
      if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleCopy();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, currentIndex, filteredMedia.length]);

  // 打开面板后，优先预热"当前 + 前后若干"的图片，提升切换/首帧速度
  useEffect(() => {
    if (!open) return;
    
    const getMediaSrc = (item: SessionMediaItem) => {
      const raw = item.url || item.data || '';
      if (!raw) return '';
      return resolveMediaSrc(raw, item.mimeType || 'application/octet-stream');
    };
    
    const windowSize = 6;
    const start = Math.max(0, currentIndex - windowSize);
    const end = Math.min(filteredMedia.length - 1, currentIndex + windowSize);
    for (let i = start; i <= end; i++) {
      const item = filteredMedia[i];
      if (item?.type !== 'image') continue;
      void preloadImage(getMediaSrc(item), { decode: true });
    }
  }, [open, currentIndex, filteredMedia]);

  // 当选中项变化时，让左侧列表对齐到当前项（避免大列表里找不到当前项）
  useEffect(() => {
    if (!open) return;
    // requestAnimationFrame 避免面板初次打开时尺寸尚未稳定导致 scrollToIndex 不生效
    const id = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: currentIndex, align: 'center', behavior: 'auto' });
    });
    return () => cancelAnimationFrame(id);
  }, [open, currentIndex]);

  // ============ 现在可以安全地做条件返回 ============
  if (!open || filteredMedia.length === 0) return null;

  const currentItem = filteredMedia[currentIndex];

  const getMediaSrc = (item: SessionMediaItem) => {
    const raw = item.url || item.data || '';
    if (!raw) return '';
    // 统一处理：纯 base64 / 后端相对路径 / 本地路径
    // 注意：resolveMediaSrc 内部会对"纯 base64"补齐 data: 前缀
    return resolveMediaSrc(raw, item.mimeType || 'application/octet-stream');
  };

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev === 0 ? filteredMedia.length - 1 : prev - 1));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev === filteredMedia.length - 1 ? 0 : prev + 1));
  };

  // 复制图片到剪贴板
  const handleCopy = async () => {
    if (!currentItem || currentItem.type !== 'image') return;
    
    try {
      const src = getMediaSrc(currentItem);
      
      // 创建 canvas 来转换图片
      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = src;
      });

      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      ctx.drawImage(img, 0, 0);
      
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch (err) {
          console.error('复制失败:', err);
        }
      }, 'image/png');
    } catch (error) {
      console.error('复制图片失败:', error);
    }
  };

  // 下载媒体
  const handleDownload = (item: SessionMediaItem, index: number) => {
    try {
      const ext = item.mimeType.split('/')[1] || 'bin';
      const filename = `session-${item.type}-${Date.now()}-${index + 1}.${ext}`;

      const src = getMediaSrc(item);
      if (!src) return;

      // data URL：直接转 Blob 下载（也覆盖了“url 字段放纯 base64”的历史情况）
      if (src.startsWith('data:')) {
        const parsed = dataUrlToBlob(src);
        if (!parsed) return;
        const url = URL.createObjectURL(parsed.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return;
      }

      // 普通 URL：fetch 下载
      fetch(src)
        .then(res => res.blob())
        .then(blob => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        });
    } catch (error) {
      console.error(`下载${item.type}失败:`, error);
    }
  };

  // 批量下载选中项
  const handleDownloadSelected = () => {
    selectedItems.forEach(index => {
      handleDownload(filteredMedia[index], index);
    });
  };

  // 切换选择项
  const toggleSelect = (index: number) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedItems(newSelected);
  };

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (selectedItems.size === filteredMedia.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(filteredMedia.map((_, i) => i)));
    }
  };

  // 渲染媒体列表项
  const renderListItem = (item: SessionMediaItem, index: number) => {
    const isActive = index === currentIndex;
    const isSelected = selectedItems.has(index);
    
    return (
      <div
        key={index}
        className={`p-2 rounded-lg cursor-pointer transition-all ${
          isActive 
            ? 'bg-primary-500/10 border-2 border-primary-500' 
            : 'bg-gray-50 dark:bg-[#2a2a2a] border-2 border-transparent hover:bg-gray-100 dark:hover:bg-[#363636]'
        }`}
        onClick={() => setCurrentIndex(index)}
      >
        <div className="flex items-center gap-2">
          {/* 选择框 */}
          {isSelecting && (
            <div
              className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 cursor-pointer ${
                isSelected
                  ? 'bg-primary-500 border-primary-500'
                  : 'border-gray-300 dark:border-gray-600'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                toggleSelect(index);
              }}
            >
              {isSelected && <Check className="w-3 h-3 text-white" />}
            </div>
          )}
          
          {/* 缩略图 */}
          <div className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-gray-200 dark:bg-[#404040]">
            {item.type === 'image' && (
              <img
                src={getMediaSrc(item)}
                alt={`图片 ${index + 1}`}
                className="w-full h-full object-cover"
                loading="lazy"
                decoding="async"
                draggable={false}
              />
            )}
            {item.type === 'video' && (
              <div className="relative w-full h-full bg-gray-900">
                <video src={getMediaSrc(item)} className="w-full h-full object-cover" muted />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Play className="w-4 h-4 text-white" />
                </div>
              </div>
            )}
            {item.type === 'audio' && (
              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary-500 to-primary-700">
                <Music className="w-5 h-5 text-white/80" />
              </div>
            )}
          </div>
          
          {/* 信息 */}
          <div className="flex-1 min-w-0">
            <div className="font-medium text-xs text-gray-800 dark:text-gray-200">
              {item.type === 'image' ? '图片' : item.type === 'video' ? '视频' : '音频'} {index + 1}
            </div>
            <div className="text-[10px] text-gray-500 dark:text-gray-400">
              {item.role === 'user' ? '用户' : item.role === 'assistant' ? 'AI' : 'MCP'}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // 渲染主预览内容
  const renderPreviewContent = () => {
    if (!currentItem) return null;

    if (currentItem.type === 'image') {
      return (
        <div className="flex items-center justify-center h-full p-4">
          <img
            src={getMediaSrc(currentItem)}
            alt={`图片 ${currentIndex + 1}`}
            className="max-w-full max-h-full object-contain rounded-lg shadow-lg select-all"
            style={{ userSelect: 'auto' }}
          />
        </div>
      );
    }

    if (currentItem.type === 'video') {
      return (
        <div className="flex items-center justify-center h-full p-4">
          <video
            ref={videoRef}
            key={currentIndex}
            src={getMediaSrc(currentItem)}
            controls
            autoPlay
            className="max-w-full max-h-full rounded-lg shadow-lg"
          />
        </div>
      );
    }

    if (currentItem.type === 'audio') {
      return (
        <div className="flex flex-col items-center justify-center h-full p-6">
          <div className="w-24 h-24 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center shadow-lg mb-4">
            <Music className="w-12 h-12 text-white/80" />
          </div>
          <div className="text-center mb-4">
            <div className="font-medium text-gray-800 dark:text-gray-200">音频 {currentIndex + 1}</div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{currentItem.mimeType}</div>
          </div>
          <audio
            ref={audioRef}
            key={currentIndex}
            src={getMediaSrc(currentItem)}
            controls
            autoPlay
            className="w-full max-w-md"
          />
        </div>
      );
    }

    return null;
  };

  // 统计信息
  const imageCount = filteredMedia.filter(m => m.type === 'image').length;
  const videoCount = filteredMedia.filter(m => m.type === 'video').length;
  const audioCount = filteredMedia.filter(m => m.type === 'audio').length;

  return createPortal(
    <>
      {/* 背景遮罩 */}
      <div 
        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[9998] transition-opacity"
        onClick={onClose}
      />
      
      {/* 滑出面板 */}
      <div
        ref={panelRef}
        className="fixed top-0 right-0 h-full w-[650px] max-w-[95vw] bg-white dark:bg-[#1e1e1e] shadow-2xl z-[9999] flex flex-col animate-in slide-in-from-right duration-300"
      >
        {/* 面板头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-[#404040]">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <ImageIcon className="w-5 h-5 text-primary-500" />
              <span className="font-medium text-gray-800 dark:text-gray-200">会话媒体</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              {imageCount > 0 && <span>{imageCount} 图片</span>}
              {videoCount > 0 && <span>{videoCount} 视频</span>}
              {audioCount > 0 && <span>{audioCount} 音频</span>}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* 选择模式切换 */}
            <button
              onClick={() => {
                setIsSelecting(!isSelecting);
                if (isSelecting) setSelectedItems(new Set());
              }}
              className={`px-2 py-1.5 rounded-lg text-xs transition-colors ${
                isSelecting 
                  ? 'bg-primary-500 text-white' 
                  : 'hover:bg-gray-100 dark:hover:bg-[#363636] text-gray-600 dark:text-gray-400'
              }`}
            >
              {isSelecting ? '取消选择' : '多选'}
            </button>
            
            {/* 批量操作 */}
            {isSelecting && selectedItems.size > 0 && (
              <button
                onClick={handleDownloadSelected}
                className="px-2 py-1.5 rounded-lg text-xs bg-primary-500 text-white hover:bg-primary-600 transition-colors"
              >
                下载 ({selectedItems.size})
              </button>
            )}
            
            {/* 关闭按钮 */}
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-[#363636] transition-colors ml-2"
              title="关闭 (Esc)"
            >
              <X className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>
          </div>
        </div>

        {/* 主内容区域 */}
        <div className="flex-1 flex min-h-0">
          {/* 左侧媒体列表 */}
          <div className="w-48 border-r border-gray-200 dark:border-[#404040] flex flex-col">
            {/* 列表头部 */}
            <div className="px-3 py-2 border-b border-gray-100 dark:border-[#333] flex items-center justify-between">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {currentIndex + 1} / {filteredMedia.length}
              </span>
              {isSelecting && (
                <button
                  onClick={toggleSelectAll}
                  className="text-xs text-primary-500 hover:text-primary-600"
                >
                  {selectedItems.size === filteredMedia.length ? '取消全选' : '全选'}
                </button>
              )}
            </div>
            
            {/* 列表内容 */}
            <div className="flex-1 min-h-0">
              <Virtuoso
                ref={listRef}
                data={filteredMedia}
                overscan={240}
                itemContent={(index, item) => renderListItem(item, index)}
                className="h-full"
              />
            </div>
          </div>

          {/* 右侧预览区域 */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* 预览工具栏 */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 dark:border-[#333]">
              <div className="flex items-center gap-2">
                {/* 上下切换 */}
                <button
                  onClick={goToPrevious}
                  className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-[#363636] transition-colors"
                  title="上一个 (↑)"
                >
                  <ChevronUp className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                </button>
                <button
                  onClick={goToNext}
                  className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-[#363636] transition-colors"
                  title="下一个 (↓)"
                >
                  <ChevronDown className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                </button>
              </div>
              
              <div className="flex items-center gap-1">
                {/* 复制按钮（仅图片） */}
                {currentItem?.type === 'image' && (
                  <button
                    onClick={handleCopy}
                    className={`p-1.5 rounded transition-colors flex items-center gap-1 text-xs ${
                      copied
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-600'
                        : 'hover:bg-gray-100 dark:hover:bg-[#363636] text-gray-600 dark:text-gray-400'
                    }`}
                    title="复制图片 (Ctrl+C)"
                  >
                    {copied ? (
                      <>
                        <Check className="w-4 h-4" />
                        <span>已复制</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-4 h-4" />
                        <span>复制</span>
                      </>
                    )}
                  </button>
                )}
                
                {/* 下载按钮 */}
                <button
                  onClick={() => currentItem && handleDownload(currentItem, currentIndex)}
                  className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-[#363636] transition-colors flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400"
                  title="下载"
                >
                  <Download className="w-4 h-4" />
                  <span>下载</span>
                </button>
              </div>
            </div>
            
            {/* 预览内容 */}
            <div className="flex-1 min-h-0 bg-gray-50 dark:bg-[#151515] overflow-hidden">
              {renderPreviewContent()}
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
};

export default SessionMediaPanel;
