/**
 * Workflow 媒体管理 Hook
 * 管理媒体附件、预览、拖拽等
 */

import { useState, useCallback } from 'react';
import type { SessionMediaItem } from '../../ui/SessionMediaPanel';

export interface MediaAttachment {
  type: 'image' | 'video' | 'audio';
  mimeType: string;
  data: string; // base64 编码的数据
  preview?: string; // 预览 URL（用于显示）
}

export interface UseWorkflowMediaReturn {
  attachedMedia: MediaAttachment[];
  setAttachedMedia: React.Dispatch<React.SetStateAction<MediaAttachment[]>>;
  useThoughtSignature: boolean;
  setUseThoughtSignature: (use: boolean) => void;
  mediaPreviewOpen: boolean;
  setMediaPreviewOpen: (open: boolean) => void;
  mediaPreviewItem: SessionMediaItem | null;
  setMediaPreviewItem: (item: SessionMediaItem | null) => void;
  openSingleMediaViewer: (item: SessionMediaItem) => void;
  isDraggingOver: boolean;
  setIsDraggingOver: (dragging: boolean) => void;
}

export function useWorkflowMedia(): UseWorkflowMediaReturn {
  // 多模态内容（图片、视频、音频）
  const [attachedMedia, setAttachedMedia] = useState<MediaAttachment[]>([]);

  // 生图：是否在上下文中回灌"模型生成图片的 thoughtSignature"
  const [useThoughtSignature, setUseThoughtSignature] = useState(true);

  // 媒体预览（弹窗）
  const [mediaPreviewOpen, setMediaPreviewOpen] = useState(false);
  const [mediaPreviewItem, setMediaPreviewItem] = useState<SessionMediaItem | null>(null);

  const openSingleMediaViewer = useCallback((item: SessionMediaItem) => {
    setMediaPreviewItem(item);
    setMediaPreviewOpen(true);
  }, []);

  const [isDraggingOver, setIsDraggingOver] = useState(false);

  return {
    attachedMedia,
    setAttachedMedia,
    useThoughtSignature,
    setUseThoughtSignature,
    mediaPreviewOpen,
    setMediaPreviewOpen,
    mediaPreviewItem,
    setMediaPreviewItem,
    openSingleMediaViewer,
    isDraggingOver,
    setIsDraggingOver,
  };
}
