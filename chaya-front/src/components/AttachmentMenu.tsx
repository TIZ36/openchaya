/**
 * 附件菜单：图片/视频与文字文件上传 + Chatu 创作画廊（不含 Skill）
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Paperclip, ImageIcon, FileText, Loader2, Film, Check } from 'lucide-react';
import { mediaApi, type MediaOutputItem } from '../services/mediaApi';
import { Button } from './ui/Button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/Dialog';

interface AttachmentMenuProps {
  onAttachFile: (files: FileList) => void;
  /** 直接添加媒体（从画廊选取） */
  onAttachMediaDirect?: (item: { type: 'image' | 'video' | 'audio'; mimeType: string; data: string; preview?: string }) => void;
  attachedCount?: number;
  large?: boolean;
  iconOnly?: boolean;
  className?: string;
}

const AttachmentMenu: React.FC<AttachmentMenuProps> = ({
  onAttachFile,
  onAttachMediaDirect,
  attachedCount = 0,
  large = false,
  iconOnly = false,
  className = '',
}) => {
  const [open, setOpen] = useState(false);

  const [chatuOutputs, setChatuOutputs] = useState<MediaOutputItem[]>([]);
  const [chatuLoading, setChatuLoading] = useState(false);
  const [chatuLoaded, setChatuLoaded] = useState(false);
  const [fetchingId, setFetchingId] = useState<string | null>(null);

  const loadChatuOutputs = useCallback(() => {
    if (chatuLoaded) return;
    setChatuLoading(true);
    mediaApi
      .listOutputs(30, 0)
      .then((res) => {
        setChatuOutputs(res.items || []);
        setChatuLoaded(true);
      })
      .catch(() => setChatuOutputs([]))
      .finally(() => setChatuLoading(false));
  }, [chatuLoaded]);

  useEffect(() => {
    if (open && !chatuLoaded) {
      loadChatuOutputs();
    }
  }, [open, chatuLoaded, loadChatuOutputs]);

  const handlePickGalleryItem = useCallback(
    async (item: MediaOutputItem) => {
      if (!onAttachMediaDirect || fetchingId) return;
      const url = mediaApi.getOutputFileUrl(item.output_id);
      setFetchingId(item.output_id);
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        const mime = item.mime_type || blob.type || 'image/png';
        const isVideo = mime.startsWith('video/');

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const b64 = dataUrl.includes(';base64,') ? dataUrl.split(';base64,')[1] : dataUrl.split(',')[1] || '';
          onAttachMediaDirect({
            type: isVideo ? 'video' : 'image',
            mimeType: mime,
            data: b64,
            preview: dataUrl,
          });
          setFetchingId(null);
        };
        reader.onerror = () => setFetchingId(null);
        reader.readAsDataURL(blob);
      } catch {
        setFetchingId(null);
      }
    },
    [onAttachMediaDirect, fetchingId],
  );

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className={`${large ? 'h-10 min-w-10 rounded-2xl px-2.5' : 'h-7 px-2'} ${iconOnly ? 'gap-0' : 'gap-1'} text-[11px] text-muted-foreground hover:text-foreground ${className}`}
        title="附件：图片、视频与文字文件"
      >
        <Paperclip className={`${large ? 'w-4.5 h-4.5' : 'w-3 h-3'} shrink-0`} />
        {!iconOnly ? (
          <>
            <ImageIcon className="w-3 h-3 shrink-0 opacity-80" />
            <FileText className="w-3 h-3 shrink-0 opacity-80" />
            <span>附件</span>
          </>
        ) : null}
        {!iconOnly && attachedCount > 0 ? <span className="text-[10px] font-medium tabular-nums">{attachedCount}</span> : null}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
        }}
      >
        <DialogContent className="chatee-dialog-standard max-w-md flex flex-col max-h-[70vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Paperclip className="w-5 h-5 text-primary-600 dark:text-primary-400" />
              附件
            </DialogTitle>
            <DialogDescription>上传图片、视频或文字文件；可从 Chatu 创作库选取</DialogDescription>
          </DialogHeader>

          <div
            className="flex-1 min-h-0 overflow-y-auto pr-2 no-scrollbar py-2"
            style={{ maxHeight: '50vh' }}
          >
            <div className="space-y-4">
              {/* 图片 / 视频 */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-[#c8c8c8]">
                  <ImageIcon className="w-3.5 h-3.5 text-emerald-600 dark:text-[#00d4aa]" />
                  <span>图片 / 视频</span>
                  {attachedCount > 0 && (
                    <span className="text-[10px] font-normal text-emerald-600 dark:text-[#00d4aa]">
                      已选 {attachedCount} 项
                    </span>
                  )}
                </div>
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm bg-muted/50 text-gray-700 dark:text-[#d0d0d0] cursor-pointer hover:bg-muted/70 border border-transparent hover:border-border/40 transition-colors">
                  <ImageIcon className="w-4 h-4 flex-shrink-0" />
                  <span>选择图片或视频文件</span>
                  <input
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        onAttachFile(e.target.files);
                        e.target.value = '';
                      }
                    }}
                  />
                </label>
              </div>

              {/* 文字 / 文档 */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-[#c8c8c8]">
                  <FileText className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                  <span>文字 / 文档</span>
                </div>
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm bg-muted/50 text-gray-700 dark:text-[#d0d0d0] cursor-pointer hover:bg-muted/70 border border-transparent hover:border-border/40 transition-colors">
                  <FileText className="w-4 h-4 flex-shrink-0" />
                  <span>选择 .txt / .md / 文本或 JSON 等</span>
                  <input
                    type="file"
                    accept="text/*,.txt,.md,.csv,.json,.xml,.log,application/json"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        onAttachFile(e.target.files);
                        e.target.value = '';
                      }
                    }}
                  />
                </label>
                <p className="text-[11px] text-gray-500 dark:text-[#888] px-0.5">
                  文字类文件内容将插入到输入框中
                </p>
              </div>

              {/* Chatu 创作资源画廊 */}
              {onAttachMediaDirect && (
                <div className="space-y-2 pt-1 border-t border-gray-200 dark:border-[#404040]">
                  <div className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-[#c8c8c8]">
                    <ImageIcon className="w-3.5 h-3.5 text-[var(--color-secondary,#ff6b9d)]" />
                    <span>Chatu 创作</span>
                    {chatuOutputs.length > 0 && (
                      <span className="text-[10px] font-normal text-[var(--color-secondary,#ff6b9d)]">
                        {chatuOutputs.length} 项
                      </span>
                    )}
                  </div>
                  {chatuLoading ? (
                    <div className="flex items-center gap-2 py-2 text-xs text-gray-500 dark:text-[#888]">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中...
                    </div>
                  ) : chatuOutputs.length === 0 ? (
                    <p className="text-[11px] text-gray-500 dark:text-[#888] px-1">
                      暂无创作资源 — 在「创作」Tab 生成图片/视频后出现
                    </p>
                  ) : (
                    <div className="grid grid-cols-5 gap-1.5 max-h-[200px] overflow-y-auto no-scrollbar">
                      {chatuOutputs.map((item) => {
                        const isVideo = item.media_type === 'video';
                        const isFetching = fetchingId === item.output_id;
                        const thumbUrl = mediaApi.getOutputFileUrl(item.output_id);
                        return (
                          <button
                            key={item.output_id}
                            type="button"
                            className="relative aspect-square rounded-md overflow-hidden border border-transparent hover:border-[var(--color-accent,#00ff88)]/50 transition-all cursor-pointer group/gi"
                            onClick={() => handlePickGalleryItem(item)}
                            disabled={!!fetchingId}
                            title="点击添加到输入框"
                          >
                            {isVideo ? (
                              <div className="w-full h-full bg-black flex items-center justify-center">
                                <Film className="w-4 h-4 text-[var(--color-secondary,#ff6b9d)]" />
                              </div>
                            ) : (
                              <img
                                src={thumbUrl}
                                alt=""
                                className="w-full h-full object-cover bg-black"
                                loading="lazy"
                              />
                            )}
                            <div className="absolute inset-0 bg-black/0 group-hover/gi:bg-black/40 flex items-center justify-center opacity-0 group-hover/gi:opacity-100 transition-all">
                              {isFetching ? (
                                <Loader2 className="w-4 h-4 animate-spin text-white" />
                              ) : (
                                <Check className="w-4 h-4 text-white" />
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="secondary" size="sm" className="niho-close-pink" onClick={() => setOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default AttachmentMenu;
