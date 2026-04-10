import React, { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Copy, Download, Check, X, Image as ImageIcon } from 'lucide-react';
import { resolveMediaSrc } from '@/utils/mediaSrc';
import type { SessionMediaItem } from '@/components/ui/SessionMediaPanel';
import { dataUrlToBlob } from '@/utils/dataUrl';

export interface MediaPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: SessionMediaItem | null;
  title?: string;
}

export const MediaPreviewDialog: React.FC<MediaPreviewDialogProps> = ({
  open,
  onOpenChange,
  item,
  title = '媒体预览',
}) => {
  const [copied, setCopied] = useState(false);

  const src = useMemo(() => {
    if (!item) return '';
    const raw = item.url || item.data || '';
    if (!raw) return '';
    return resolveMediaSrc(raw, item.mimeType || 'application/octet-stream');
  }, [item]);

  const handleDownload = async () => {
    if (!item) return;
    const ext = (item.mimeType || '').split('/')[1] || 'bin';
    const filename = `media-${item.type}-${Date.now()}.${ext}`;
    if (!src) return;

    // data URL
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

    // normal url
    const blob = await fetch(src).then((r) => r.blob());
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    if (!item || item.type !== 'image') return;
    if (!src) return;
    try {
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
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.error('[MediaPreviewDialog] copy failed:', e);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[92vw] w-[980px] p-0 overflow-hidden">
        <div className="border-b border-gray-200 dark:border-[#404040] px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <ImageIcon className="w-4 h-4 text-primary-500" />
            <DialogHeader className="min-w-0">
              <DialogTitle className="text-sm truncate">{title}</DialogTitle>
              <DialogDescription className="text-xs truncate">
                {item?.type === 'image' ? '图片' : item?.type === 'video' ? '视频' : item?.type === 'audio' ? '音频' : '媒体'}
                {item?.messageId ? ` · 来源消息 ${item.messageId}` : ''}
              </DialogDescription>
            </DialogHeader>
          </div>
          <div className="flex items-center gap-1">
            {item?.type === 'image' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleCopy()}
                className="h-8"
              >
                {copied ? <Check className="w-4 h-4 mr-1.5" /> : <Copy className="w-4 h-4 mr-1.5" />}
                {copied ? '已复制' : '复制'}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => void handleDownload()} className="h-8">
              <Download className="w-4 h-4 mr-1.5" />
              下载
            </Button>
            <IconButton
              icon={X}
              label="关闭"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            />
          </div>
        </div>

        <div className="bg-gray-50 dark:bg-[#111] h-[70vh] flex items-center justify-center p-4">
          {!item ? (
            <div className="text-sm text-gray-500">暂无可预览内容</div>
          ) : item.type === 'image' ? (
            <img
              src={src}
              alt="preview"
              className="max-w-full max-h-full object-contain rounded-lg border border-gray-200 dark:border-[#404040] bg-white dark:bg-[#1e1e1e]"
              draggable={false}
            />
          ) : item.type === 'video' ? (
            <video
              src={src}
              controls
              autoPlay
              className="max-w-full max-h-full rounded-lg border border-gray-200 dark:border-[#404040] bg-black"
            />
          ) : (
            <audio src={src} controls autoPlay className="w-full max-w-xl" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};


