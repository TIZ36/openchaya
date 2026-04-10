import React, { useMemo, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, Play, Volume2, Film, Music, ZoomIn, ChevronUp, ChevronDown, Copy, Check } from 'lucide-react';
import { resolveMediaSrc } from '@/utils/mediaSrc';
import { preloadImage } from '@/utils/mediaPreload';
import { IconButton } from '@/components/ui/IconButton';

export interface MediaItem {
  type: 'image' | 'video' | 'audio';
  mimeType: string;
  data: string; // base64 编码的数据
  url?: string; // 如果是 URL
}

interface MediaGalleryProps {
  media: MediaItem[];
  /** 缩略图尺寸 */
  thumbnailSize?: 'sm' | 'md' | 'lg';
  /** 最大显示数量，超出部分折叠 */
  maxVisible?: number;
  /** 是否显示下载按钮 */
  showDownload?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 点击打开会话画廊的回调（如果提供，则不打开内置面板） */
  onOpenSessionGallery?: (index: number) => void;
  /** 缩略图支持“直接复制”（不打开面板） */
  enableQuickCopy?: boolean;
}

const thumbnailSizes = {
  sm: 'w-16 h-16',
  md: 'w-20 h-20',
  lg: 'w-24 h-24',
};

const EMPTY_MEDIA: MediaItem[] = [];

/**
 * 媒体画廊组件 - 横向排列缩略图，点击从右侧滑出画廊面板
 */
export const MediaGallery: React.FC<MediaGalleryProps> = ({
  media,
  thumbnailSize = 'md',
  maxVisible = 6,
  showDownload = true,
  className = '',
  onOpenSessionGallery,
  enableQuickCopy = true,
}) => {
  // ============ 所有 hooks 必须在任何条件返回之前调用 ============
  const [panelOpen, setPanelOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const safeMedia = media ?? EMPTY_MEDIA;
  
  // 构造稳定的 preloadKey，避免父组件重渲染造成 media 数组引用变化时重复 preload/decode
  const preloadKey = useMemo(() => {
    if (!safeMedia || safeMedia.length === 0) return '';
    const maxPreload = Math.min(safeMedia.length, Math.max(12, maxVisible * 2));
    const parts: string[] = [];
    for (let i = 0; i < maxPreload; i++) {
      const item = safeMedia[i];
      if (!item) continue;
      const id = item.url
        ? `u:${item.url}`
        : item.data
          ? `b:${item.mimeType || ''}:${item.data.length}:${item.data.slice(0, 16)}`
          : `e:${item.mimeType || ''}`;
      parts.push(`${item.type}:${id}`);
    }
    return parts.join('|');
  }, [safeMedia, maxVisible]);

  // 预渲染（预加载+预解码）：缩略图出现时，后台预热"即将打开媒体库"的图片
  // 为避免内存/CPU 压力，仅预热前一小段（可按需调大）
  useEffect(() => {
    if (safeMedia.length === 0) return;
    
    const getMediaSrc = (item: MediaItem) => {
      const raw = item.url || item.data || '';
      return resolveMediaSrc(raw, item.mimeType);
    };
    
    const maxPreload = Math.min(safeMedia.length, Math.max(12, maxVisible * 2));
    for (let i = 0; i < maxPreload; i++) {
      const item = safeMedia[i];
      if (item?.type !== 'image') continue;
      const src = getMediaSrc(item);
      // fire-and-forget
      void preloadImage(src, { decode: true });
    }
  }, [preloadKey, maxVisible]);

  // 键盘导航
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!panelOpen) return;
      if (e.key === 'Escape') closePanel();
      if (e.key === 'ArrowUp') goToPrevious();
      if (e.key === 'ArrowDown') goToNext();
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [panelOpen, safeMedia.length]);

  // ============ 现在可以安全地做条件返回 ============
  if (safeMedia.length === 0) return null;

  const visibleMedia = safeMedia.slice(0, maxVisible);
  const hiddenCount = safeMedia.length - maxVisible;
  const currentItem = safeMedia[currentIndex];

  const getMediaSrc = (item: MediaItem) => {
    const raw = item.url || item.data || '';
    const src = resolveMediaSrc(raw, item.mimeType);
    return src;
  };

  const quickCopyImage = async (index: number) => {
    const item = safeMedia[index];
    if (!item || item.type !== 'image') return;
    try {
      const src = getMediaSrc(item);
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
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex((prev) => (prev === index ? null : prev)), 1200);
    } catch (e) {
      console.error('[MediaGallery] quickCopy failed:', e);
    }
  };

  const handleDownload = (item: MediaItem, index: number) => {
    try {
      const ext = item.mimeType.split('/')[1] || 'bin';
      const filename = `ai-${item.type}-${Date.now()}-${index + 1}.${ext}`;

      if (item.url) {
        fetch(item.url)
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
      } else if (item.data) {
        const byteCharacters = atob(item.data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: item.mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error(`下载${item.type}失败:`, error);
    }
  };

  const openPanel = (index: number) => {
    // 如果有会话级别的画廊回调，则调用它
    if (onOpenSessionGallery) {
      // 点开前先预热当前点击的图片（命中缓存/完成 decode 后，面板首帧更快）
      const item = safeMedia[index];
      if (item?.type === 'image') {
        void preloadImage(getMediaSrc(item), { decode: true });
      }
      onOpenSessionGallery(index);
      return;
    }
    // 否则打开内置面板
    setCurrentIndex(index);
    setPanelOpen(true);
  };

  const closePanel = () => {
    setPanelOpen(false);
    if (audioRef.current) {
      audioRef.current.pause();
    }
    if (videoRef.current) {
      videoRef.current.pause();
    }
  };

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev === 0 ? safeMedia.length - 1 : prev - 1));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev === safeMedia.length - 1 ? 0 : prev + 1));
  };

  // 渲染缩略图
  const renderThumbnail = (item: MediaItem, index: number) => {
    const sizeClass = thumbnailSizes[thumbnailSize];

    if (item.type === 'image') {
      return (
        <div
          key={index}
          className={`${sizeClass} relative rounded-lg overflow-hidden cursor-pointer group border border-gray-200 dark:border-[#404040] hover:border-primary-500 dark:hover:border-primary-500 transition-all hover:scale-105 hover:shadow-lg`}
          onClick={() => openPanel(index)}
        >
          <img
            src={getMediaSrc(item)}
            alt={`图片 ${index + 1}`}
            className="w-full h-full object-cover"
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={(e) => {
              console.error(`[MediaGallery] 图片加载失败 (index=${index}):`, {
                type: item.type,
                mimeType: item.mimeType,
                dataLength: item.data?.length || 0,
                urlLength: item.url?.length || 0,
                src: (e.target as HTMLImageElement).src.substring(0, 100),
              });
              // 即使加载失败，也尝试显示占位符
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
            <ZoomIn className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          {enableQuickCopy && (
            <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <IconButton
                icon={copiedIndex === index ? Check : Copy}
                label={copiedIndex === index ? '已复制' : '复制图片'}
                variant={copiedIndex === index ? 'secondary' : 'ghost'}
                size="icon"
                className="h-7 w-7 bg-black/40 hover:bg-black/50 text-white border border-white/20"
                onClick={(e) => {
                  e.stopPropagation();
                  void quickCopyImage(index);
                }}
              />
            </div>
          )}
        </div>
      );
    }

    if (item.type === 'video') {
      return (
        <div
          key={index}
          className={`${sizeClass} relative rounded-lg overflow-hidden cursor-pointer group border border-gray-200 dark:border-[#404040] hover:border-primary-500 dark:hover:border-primary-500 transition-all hover:scale-105 hover:shadow-lg bg-gray-900`}
          onClick={() => openPanel(index)}
        >
          <video
            src={getMediaSrc(item)}
            className="w-full h-full object-cover"
            muted
            playsInline
          />
          <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition-colors flex items-center justify-center">
            <div className="w-8 h-8 rounded-full bg-white/90 flex items-center justify-center">
              <Play className="w-4 h-4 text-gray-800 ml-0.5" />
            </div>
          </div>
          <div className="absolute bottom-1 right-1 bg-black/70 text-white text-[10px] px-1 rounded flex items-center gap-0.5">
            <Film className="w-3 h-3" />
          </div>
        </div>
      );
    }

    if (item.type === 'audio') {
      return (
        <div
          key={index}
          className={`${sizeClass} relative rounded-lg overflow-hidden cursor-pointer group border border-gray-200 dark:border-[#404040] hover:border-primary-500 dark:hover:border-primary-500 transition-all hover:scale-105 hover:shadow-lg bg-gradient-to-br from-primary-500 to-primary-700`}
          onClick={() => openPanel(index)}
        >
          <div className="absolute inset-0 flex items-center justify-center">
            <Music className="w-6 h-6 text-white/80" />
          </div>
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
            <Play className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="absolute bottom-1 right-1 bg-black/70 text-white text-[10px] px-1 rounded flex items-center gap-0.5">
            <Volume2 className="w-3 h-3" />
          </div>
        </div>
      );
    }

    return null;
  };

  // 渲染侧边面板中的媒体列表项
  const renderPanelItem = (item: MediaItem, index: number) => {
    const isActive = index === currentIndex;
    
    return (
      <div
        key={index}
        className={`p-3 rounded-lg cursor-pointer transition-all ${
          isActive 
            ? 'bg-primary-500/10 border-2 border-primary-500' 
            : 'bg-gray-50 dark:bg-[#2a2a2a] border-2 border-transparent hover:bg-gray-100 dark:hover:bg-[#363636]'
        }`}
        onClick={() => setCurrentIndex(index)}
      >
        <div className="flex items-center gap-3">
          {/* 缩略图 */}
          <div className="w-16 h-16 rounded-lg overflow-hidden flex-shrink-0 bg-gray-200 dark:bg-[#404040]">
            {item.type === 'image' && (
              <img
                src={getMediaSrc(item)}
                alt={`图片 ${index + 1}`}
                className="w-full h-full object-cover"
              />
            )}
            {item.type === 'video' && (
              <div className="relative w-full h-full bg-gray-900">
                <video
                  src={getMediaSrc(item)}
                  className="w-full h-full object-cover"
                  muted
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-8 h-8 rounded-full bg-white/80 flex items-center justify-center">
                    <Play className="w-4 h-4 text-gray-800 ml-0.5" />
                  </div>
                </div>
              </div>
            )}
            {item.type === 'audio' && (
              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary-500 to-primary-700">
                <Music className="w-6 h-6 text-white/80" />
              </div>
            )}
          </div>
          
          {/* 信息 */}
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm text-gray-800 dark:text-gray-200 capitalize">
              {item.type === 'image' ? '图片' : item.type === 'video' ? '视频' : '音频'} {index + 1}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {item.mimeType}
            </div>
          </div>
          
          {/* 下载按钮 */}
          {showDownload && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDownload(item, index);
              }}
              className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-[#404040] transition-colors"
              title="下载"
            >
              <Download className="w-4 h-4 text-gray-600 dark:text-gray-400" />
            </button>
          )}
        </div>
      </div>
    );
  };

  // 渲染主预览区域内容
  const renderPreviewContent = () => {
    if (!currentItem) return null;

    if (currentItem.type === 'image') {
      return (
        <div className="flex items-center justify-center h-full p-4">
          <img
            src={getMediaSrc(currentItem)}
            alt={`图片 ${currentIndex + 1}`}
            className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
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
          {/* 音频可视化占位 */}
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center shadow-lg mb-6">
            <Music className="w-16 h-16 text-white/80" />
          </div>
          
          {/* 音频信息 */}
          <div className="text-center mb-6">
            <div className="font-medium text-gray-800 dark:text-gray-200">音频 {currentIndex + 1}</div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{currentItem.mimeType}</div>
          </div>
          
          {/* 音频播放器 */}
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

  return (
    <>
      {/* 缩略图画廊 */}
      <div className={`flex flex-wrap gap-2 ${className}`}>
        {visibleMedia.map((item, index) => renderThumbnail(item, index))}
        
        {/* 显示更多 */}
        {hiddenCount > 0 && (
          <div
            className={`${thumbnailSizes[thumbnailSize]} relative rounded-lg overflow-hidden cursor-pointer border border-gray-200 dark:border-[#404040] bg-gray-100 dark:bg-[#363636] flex items-center justify-center hover:bg-gray-200 dark:hover:bg-[#404040] transition-colors`}
            onClick={() => openPanel(maxVisible)}
          >
            <span className="text-gray-600 dark:text-gray-300 font-medium text-sm">
              +{hiddenCount}
            </span>
          </div>
        )}
      </div>

      {/* 右侧滑出面板 - 使用 Portal 渲染到 body */}
      {panelOpen && createPortal(
        <>
          {/* 背景遮罩 */}
          <div 
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[9998] transition-opacity"
            onClick={closePanel}
          />
          
          {/* 滑出面板 - 更大宽度 */}
          <div
            ref={panelRef}
            className="fixed top-0 right-0 h-full w-[600px] max-w-[95vw] bg-white dark:bg-[#1e1e1e] shadow-2xl z-[9999] flex flex-col animate-in slide-in-from-right duration-300"
          >
            {/* 面板头部 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-[#404040]">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-800 dark:text-gray-200">媒体预览</span>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {currentIndex + 1} / {safeMedia.length}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {/* 上下切换按钮 */}
                {safeMedia.length > 1 && (
                  <>
                    <button
                      onClick={goToPrevious}
                      className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-[#363636] transition-colors"
                      title="上一个 (↑)"
                    >
                      <ChevronUp className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                    </button>
                    <button
                      onClick={goToNext}
                      className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-[#363636] transition-colors"
                      title="下一个 (↓)"
                    >
                      <ChevronDown className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                    </button>
                  </>
                )}
                {/* 下载当前 */}
                {showDownload && currentItem && (
                  <button
                    onClick={() => handleDownload(currentItem, currentIndex)}
                    className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-[#363636] transition-colors"
                    title="下载当前文件"
                  >
                    <Download className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                  </button>
                )}
                {/* 关闭按钮 */}
                <button
                  onClick={closePanel}
                  className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-[#363636] transition-colors"
                  title="关闭 (Esc)"
                >
                  <X className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                </button>
              </div>
            </div>

            {/* 主预览区域 */}
            <div className="flex-1 min-h-0 bg-gray-50 dark:bg-[#151515] overflow-hidden">
              {renderPreviewContent()}
            </div>

            {/* 媒体列表 */}
            {safeMedia.length > 1 && (
              <div className="border-t border-gray-200 dark:border-[#404040] max-h-[240px] overflow-y-auto">
                <div className="p-3 space-y-2">
                  {safeMedia.map((item, index) => renderPanelItem(item, index))}
                </div>
              </div>
            )}
          </div>
        </>,
        document.body
      )}
    </>
  );
};

export default MediaGallery;
