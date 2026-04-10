/**
 * ChatInput Component
 * 
 * Isolated input component that doesn't re-render when messages change.
 * This significantly improves typing performance during streaming responses.
 */

import React, { memo, useState, useRef, useCallback, useEffect } from 'react';
import {
  Send,
  Paperclip,
  Image,
  Mic,
  StopCircle,
  X,
  Video,
  FileImage,
  Loader2,
} from 'lucide-react';
import { Textarea } from '../ui/Textarea';
import { Label } from '../ui/Label';
import { Button } from '../ui/Button';
import { calculateCursorPosition } from './utils';

export interface MediaAttachment {
  type: 'image' | 'video' | 'audio';
  mimeType: string;
  data: string;
  preview?: string;
}

export interface ChatInputProps {
  /** Current input value */
  value: string;
  /** Input change callback */
  onChange: (value: string) => void;
  /** Send message callback */
  onSend: () => void;
  /** Stop generation callback */
  onStop?: () => void;
  /** Whether currently loading/generating */
  isLoading?: boolean;
  /** Whether input is disabled */
  disabled?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Media attachments */
  attachedMedia?: MediaAttachment[];
  /** Add media callback */
  onAddMedia?: (media: MediaAttachment) => void;
  /** Remove media callback */
  onRemoveMedia?: (index: number) => void;
  /** Media drop callback */
  onMediaDrop?: (files: File[]) => void;
  /** Input ref for external control */
  inputRef?: React.RefObject<HTMLTextAreaElement>;
  /** Composing state ref */
  isComposingRef?: React.MutableRefObject<boolean>;
  /** Key down handler */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** Children (for selectors, etc.) */
  children?: React.ReactNode;
  /** Class name for the container */
  className?: string;
}

/**
 * Inner component (to be memoized)
 */
const ChatInputInner: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  onStop,
  isLoading = false,
  disabled = false,
  placeholder = '输入消息...',
  attachedMedia = [],
  onAddMedia,
  onRemoveMedia,
  onMediaDrop,
  inputRef: externalInputRef,
  isComposingRef: externalComposingRef,
  onKeyDown,
  children,
  className = '',
}) => {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const localInputRef = useRef<HTMLTextAreaElement>(null);
  const localComposingRef = useRef(false);
  
  const inputRef = externalInputRef || localInputRef;
  const isComposingRef = externalComposingRef || localComposingRef;

  // Auto-resize textarea
  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const newHeight = Math.min(textarea.scrollHeight, 200); // Max 200px
      textarea.style.height = `${newHeight}px`;
    }
  }, [value, inputRef]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  }, [onChange]);

  const handleKeyPress = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    if (isComposingRef.current || (e.nativeEvent as any)?.isComposing) return;
    if (e.shiftKey) return;
    if (disabled || isLoading) return;
    
    e.preventDefault();
    onSend();
  }, [disabled, isLoading, onSend, isComposingRef]);

  const handleKeyDownInternal = useCallback((e: React.KeyboardEvent) => {
    handleKeyPress(e);
    if (e.defaultPrevented) return;
    onKeyDown?.(e);
  }, [handleKeyPress, onKeyDown]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDraggingOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    
    const files = Array.from(e.dataTransfer.files);
    const mediaFiles = files.filter(file => 
      file.type.startsWith('image/') || 
      file.type.startsWith('video/') || 
      file.type.startsWith('audio/')
    );
    
    if (mediaFiles.length > 0 && onMediaDrop) {
      onMediaDrop(mediaFiles);
    }
  }, [onMediaDrop]);

  const handleMediaInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'video' | 'audio') => {
    const files = e.target.files;
    if (!files || !onAddMedia) return;
    
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const data = reader.result as string;
        const base64Data = data.split(',')[1];
        onAddMedia({
          type,
          mimeType: file.type,
          data: base64Data,
          preview: data,
        });
      };
      reader.readAsDataURL(file);
    });
    
    // Reset input
    e.target.value = '';
  }, [onAddMedia]);

  return (
    <div 
      className={`relative ${className} ${isDraggingOver ? 'ring-2 ring-primary-400/30' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-primary-100/50 dark:bg-primary-900/30 rounded-lg z-10 pointer-events-none">
          <div className="flex items-center gap-2 text-primary-600 dark:text-primary-400 font-medium">
            <Paperclip className="w-5 h-5" />
            <span>松开以添加媒体文件</span>
          </div>
        </div>
      )}
      
      {/* Attached media preview */}
      {attachedMedia.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachedMedia.map((media, index) => (
            <div
              key={index}
              className="relative group w-16 h-16 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700"
            >
              {media.type === 'image' && media.preview && (
                <img
                  src={media.preview}
                  alt="attachment"
                  className="w-full h-full object-cover"
                />
              )}
              {media.type === 'video' && (
                <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                  <Video className="w-6 h-6 text-gray-400" />
                </div>
              )}
              {media.type === 'audio' && (
                <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                  <Mic className="w-6 h-6 text-gray-400" />
                </div>
              )}
              <button
                onClick={() => onRemoveMedia?.(index)}
                className="absolute top-0.5 right-0.5 p-0.5 bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3 text-white" />
              </button>
            </div>
          ))}
        </div>
      )}
      
      {/* Children (selectors, etc.) */}
      {children}
      
      {/* Input area */}
      <div className="flex items-end gap-2">
        {/* Media buttons */}
        {onAddMedia && (
          <div className="flex items-center gap-1 pb-2">
            <Label
              htmlFor="chat-media-input"
              className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 cursor-pointer rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <FileImage className="w-4 h-4" />
              <input
                id="chat-media-input"
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => handleMediaInputChange(e, 'image')}
              />
            </Label>
          </div>
        )}
        
        {/* Textarea */}
        <div className="flex-1 relative">
          <Textarea
            ref={inputRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDownInternal}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            placeholder={placeholder}
            disabled={disabled}
            className="w-full resize-none text-sm"
            style={{ minHeight: '40px', maxHeight: '200px' }}
            rows={1}
          />
        </div>
        
        {/* Send/Stop button */}
        <div className="pb-2">
          {isLoading ? (
            <Button
              onClick={onStop}
              variant="destructive"
              size="icon"
              className="p-2"
              title="停止生成"
            >
              <StopCircle className="w-4 h-4" />
            </Button>
          ) : (
            <Button
              onClick={onSend}
              variant="primary"
              size="icon"
              disabled={disabled || (!value.trim() && attachedMedia.length === 0)}
              className="p-2"
              title="发送消息"
            >
              <Send className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Custom comparison for memo - only re-render when specific props change
 */
const arePropsEqual = (
  prevProps: ChatInputProps,
  nextProps: ChatInputProps
): boolean => {
  return (
    prevProps.value === nextProps.value &&
    prevProps.isLoading === nextProps.isLoading &&
    prevProps.disabled === nextProps.disabled &&
    prevProps.placeholder === nextProps.placeholder &&
    prevProps.attachedMedia === nextProps.attachedMedia &&
    prevProps.className === nextProps.className
  );
};

/**
 * Memoized ChatInput component
 */
export const ChatInput = memo(ChatInputInner, arePropsEqual);

export default ChatInput;

