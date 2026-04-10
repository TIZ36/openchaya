/**
 * Workflow 输入管理 Hook
 * 管理输入框状态、选择器、引用消息等
 */

import { useState, useRef } from 'react';

export interface QuotedMessageSnapshot {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  senderName: string;
  content: string;
  media?: Array<{ type: 'image' | 'video' | 'audio'; mimeType: string; data: string; url?: string }>;
}

export interface UseWorkflowInputReturn {
  input: string;
  setInput: (value: string) => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  isInputExpanded: boolean;
  setIsInputExpanded: (expanded: boolean) => void;
  isInputFocused: boolean;
  setIsInputFocused: (focused: boolean) => void;
  
  // 引用消息
  quotedMessageId: string | null;
  setQuotedMessageId: (id: string | null) => void;
  quotedMessageSnapshot: QuotedMessageSnapshot | null;
  setQuotedMessageSnapshot: (snapshot: QuotedMessageSnapshot | null) => void;
  quoteDetailOpen: boolean;
  setQuoteDetailOpen: (open: boolean) => void;
  
  // 编辑消息
  editingMessageId: string | null;
  setEditingMessageId: (id: string | null) => void;
  editingMessageIdRef: React.MutableRefObject<string | null>;
  
  // 思考过程折叠
  collapsedThinking: Set<string>;
  setCollapsedThinking: React.Dispatch<React.SetStateAction<Set<string>>>;
  
  // 流式响应
  streamEnabled: boolean;
  setStreamEnabled: (enabled: boolean) => void;
  
  // 中断控制
  abortController: AbortController | null;
  setAbortController: (controller: AbortController | null) => void;
  
  // 执行日志
  executionLogs: any[];
  setExecutionLogs: React.Dispatch<React.SetStateAction<any[]>>;
  isExecuting: boolean;
  setIsExecuting: (executing: boolean) => void;
  
  // @ 选择器
  showAtSelector: boolean;
  setShowAtSelector: (show: boolean) => void;
  atSelectorQuery: string;
  setAtSelectorQuery: (query: string) => void;
  selectedComponentIndex: number;
  setSelectedComponentIndex: (index: number) => void;
  selectedComponents: Array<{ type: 'mcp' | 'skillpack' | 'agent'; id: string; name: string }>;
  setSelectedComponents: React.Dispatch<React.SetStateAction<Array<{ type: 'mcp' | 'skillpack' | 'agent'; id: string; name: string }>>>;
  selectorRef: React.RefObject<HTMLDivElement>;
  blurTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  
  // 模块选择器
  showModuleSelector: boolean;
  setShowModuleSelector: (show: boolean) => void;
  
  // 批次选择器
  showBatchItemSelector: boolean;
  setShowBatchItemSelector: (show: boolean) => void;
  batchItemSelectorPosition: { top: number; left: number; maxHeight: number };
  setBatchItemSelectorPosition: (pos: { top: number; left: number; maxHeight: number }) => void;
  selectedBatch: any;
  setSelectedBatch: (batch: any) => void;
  selectedBatchItem: { item: any; batchName: string } | null;
  setSelectedBatchItem: (item: { item: any; batchName: string } | null) => void;
  pendingBatchItem: { item: any; batchName: string } | null;
  setPendingBatchItem: (item: { item: any; batchName: string } | null) => void;
}

export function useWorkflowInput(): UseWorkflowInputReturn {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isInputExpanded, setIsInputExpanded] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  
  // 引用消息
  const [quotedMessageId, setQuotedMessageId] = useState<string | null>(null);
  const [quotedMessageSnapshot, setQuotedMessageSnapshot] = useState<QuotedMessageSnapshot | null>(null);
  const [quoteDetailOpen, setQuoteDetailOpen] = useState(false);
  
  // 编辑消息
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const editingMessageIdRef = useRef<string | null>(null);
  
  // 思考过程折叠
  const [collapsedThinking, setCollapsedThinking] = useState<Set<string>>(new Set());
  
  // 流式响应
  const [streamEnabled, setStreamEnabled] = useState(true);
  
  // 中断控制
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  
  // 执行日志
  const [executionLogs, setExecutionLogs] = useState<any[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  
  // @ 选择器
  const [showAtSelector, setShowAtSelector] = useState(false);
  const [atSelectorQuery, setAtSelectorQuery] = useState('');
  const [selectedComponentIndex, setSelectedComponentIndex] = useState(0);
  const [selectedComponents, setSelectedComponents] = useState<Array<{ type: 'mcp' | 'skillpack' | 'agent'; id: string; name: string }>>([]);
  const selectorRef = useRef<HTMLDivElement>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // 模块选择器
  const [showModuleSelector, setShowModuleSelector] = useState(false);
  
  // 批次选择器
  const [showBatchItemSelector, setShowBatchItemSelector] = useState(false);
  const [batchItemSelectorPosition, setBatchItemSelectorPosition] = useState({ top: 0, left: 0, maxHeight: 400 });
  const [selectedBatch, setSelectedBatch] = useState<any>(null);
  const [selectedBatchItem, setSelectedBatchItem] = useState<{ item: any; batchName: string } | null>(null);
  const [pendingBatchItem, setPendingBatchItem] = useState<{ item: any; batchName: string } | null>(null);
  
  return {
    input,
    setInput,
    isLoading,
    setIsLoading,
    inputRef,
    isInputExpanded,
    setIsInputExpanded,
    isInputFocused,
    setIsInputFocused,
    quotedMessageId,
    setQuotedMessageId,
    quotedMessageSnapshot,
    setQuotedMessageSnapshot,
    quoteDetailOpen,
    setQuoteDetailOpen,
    editingMessageId,
    setEditingMessageId,
    editingMessageIdRef,
    collapsedThinking,
    setCollapsedThinking,
    streamEnabled,
    setStreamEnabled,
    abortController,
    setAbortController,
    executionLogs,
    setExecutionLogs,
    isExecuting,
    setIsExecuting,
    showAtSelector,
    setShowAtSelector,
    atSelectorQuery,
    setAtSelectorQuery,
    selectedComponentIndex,
    setSelectedComponentIndex,
    selectedComponents,
    setSelectedComponents,
    selectorRef,
    blurTimeoutRef,
    showModuleSelector,
    setShowModuleSelector,
    showBatchItemSelector,
    setShowBatchItemSelector,
    batchItemSelectorPosition,
    setBatchItemSelectorPosition,
    selectedBatch,
    setSelectedBatch,
    selectedBatchItem,
    setSelectedBatchItem,
    pendingBatchItem,
    setPendingBatchItem,
  };
}
