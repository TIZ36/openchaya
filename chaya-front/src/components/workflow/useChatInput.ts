import React, { useState, useRef, useCallback, useEffect } from 'react';
import { calculateCursorPosition, releaseCursorMirror } from './utils';

export interface ChatInputProps {
  input: string;
  setInput: (value: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  handleSend: () => void;
  showAtSelector: boolean;
  setShowAtSelector: (show: boolean) => void;
  atSelectorQuery: string;
  setAtSelectorQuery: (query: string) => void;
  handleSelectComponent: (component: any) => void;
  getSelectableComponents: () => any[];
  selectedComponentIndex: number;
  setSelectedComponentIndex: React.Dispatch<React.SetStateAction<number>>;
}

export const useChatInput = ({
  input,
  setInput,
  inputRef,
  handleSend,
  showAtSelector,
  setShowAtSelector,
  atSelectorQuery,
  setAtSelectorQuery,
  handleSelectComponent,
  getSelectableComponents,
  selectedComponentIndex,
  setSelectedComponentIndex,
}: ChatInputProps) => {
  const [atSelectorIndex, setAtSelectorIndex] = useState(-1);
  const [atSelectorPosition, setAtSelectorPosition] = useState({ bottom: 0, left: 0, maxHeight: 0 });
  
  const isComposingRef = useRef(false);
  const rafUpdateRef = useRef<number | null>(null);
  const atCtxMissRef = useRef(0); // 容错：避免 caret/selectionStart 瞬时抖动导致选择器“闪一下就消失”
  const lastDomSnapshotRef = useRef<string>(''); // 短路：避免重复测量

  const getAtTriggerContext = useCallback(
    (text: string, caret: number): { start: number; query: string } | null => {
      const safeCaret = Math.max(0, Math.min(caret, text.length));
      const left = text.slice(0, safeCaret);
      const at = left.lastIndexOf('@');
      if (at < 0) return null;
      const query = left.slice(at + 1);
      // @ 与光标之间不能出现空白（只在同一个 token 内触发）
      if (/[ \t\r\n]/.test(query)) return null;
      // 避免把邮箱/英文 token 当成 @ 选择器（如 email@domain.com）
      const prev = at === 0 ? '' : text[at - 1];
      if (prev && /[A-Za-z0-9._%+\-]/.test(prev)) return null;
      return { start: at, query };
    },
    []
  );

  const updateSelectorsFromDom = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const value = el.value ?? '';
    const cursorPosition = el.selectionStart ?? value.length;
    const textBeforeCursor = value.substring(0, cursorPosition);

    // 只有 DOM 状态变化时才继续（避免 onChange+onKeyUp 等重复触发造成卡顿）
    const snap = `${cursorPosition}|${el.scrollTop}|${el.scrollLeft}|${showAtSelector ? 1 : 0}|${value.length}`;
    if (snap === lastDomSnapshotRef.current) return;
    lastDomSnapshotRef.current = snap;

    // Detect @ token（基于 caret 的 token 上下文）
    const atCtx = getAtTriggerContext(value, cursorPosition);
    if (atCtx) {
      atCtxMissRef.current = 0;
      setAtSelectorIndex(atCtx.start);
      setAtSelectorQuery(atCtx.query.toLowerCase());

      const { x, y } = calculateCursorPosition(el, textBeforeCursor);
      const selectorMaxHeight = 256;
      const selectorMinHeight = 120;
      const selectorWidth = 280;
      const viewportWidth = window.innerWidth;

      let left = x + 8;
      if (left + selectorWidth > viewportWidth - 10) {
        left = x - selectorWidth - 8;
        if (left < 10) left = x + 8;
      }
      if (left < 10) left = 10;

      const rawBottom = window.innerHeight - y + 5;
      const bottom = Math.max(10, Math.min(rawBottom, window.innerHeight - selectorMinHeight - 10));
      const availableHeightAbove = y - 20;
      const actualMaxHeight = Math.max(
        selectorMinHeight,
        Math.min(selectorMaxHeight, availableHeightAbove)
      );

      setAtSelectorPosition({ bottom, left, maxHeight: actualMaxHeight });
      setShowAtSelector(true);
      setSelectedComponentIndex(0);
      return;
    }

    if (showAtSelector) {
      // 容错：允许 1 次瞬时 miss（常见于受控 textarea/输入法导致 selectionStart 抖动）
      atCtxMissRef.current += 1;
      if (atCtxMissRef.current < 2) {
        return;
      }
      setShowAtSelector(false);
      setAtSelectorIndex(-1);
      atCtxMissRef.current = 0;
    }
  }, [
    inputRef,
    getAtTriggerContext,
    setAtSelectorQuery,
    setSelectedComponentIndex,
    setShowAtSelector,
    showAtSelector,
  ]);

  const scheduleUpdateSelectors = useCallback(() => {
    if (rafUpdateRef.current) cancelAnimationFrame(rafUpdateRef.current);
    rafUpdateRef.current = requestAnimationFrame(() => {
      rafUpdateRef.current = null;
      updateSelectorsFromDom();
    });
  }, [updateSelectorsFromDom]);

  // 卸载时清理 rAF 与 mirror（避免残留 DOM，让人误判“内存泄漏”）
  useEffect(() => {
    const el = inputRef.current;
    return () => {
      if (rafUpdateRef.current) cancelAnimationFrame(rafUpdateRef.current);
      releaseCursorMirror(el);
    };
  }, [inputRef]);

  // 当下拉显示时，窗口尺寸变化也需要重算位置
  useEffect(() => {
    if (!showAtSelector) return;
    const onResize = () => scheduleUpdateSelectors();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [scheduleUpdateSelectors, showAtSelector]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // 在受控 textarea 场景下，某些平台/输入法会导致 selectionStart 瞬时异常，
    // 用 rAF 在 DOM commit 后读取真实 caret，避免“闪一下就消失”。
    scheduleUpdateSelectors();
  }, [scheduleUpdateSelectors, setInput]);

  // 光标移动/选区变化：不一定触发 onChange，需要单独刷新（但尽量做得很轻）
  const handleInputSelect = useCallback(() => {
    if (isComposingRef.current) return;
    if (!showAtSelector) return;
    scheduleUpdateSelectors();
  }, [scheduleUpdateSelectors, showAtSelector]);

  const handleInputClick = handleInputSelect;
  const handleInputMouseUp = handleInputSelect;

  const handleInputKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposingRef.current) return;
      // 只对“移动光标”的键触发，避免输入字符时重复触发（onChange 已经会触发）
      const k = e.key;
      const isNavKey =
        k === 'ArrowLeft' ||
        k === 'ArrowRight' ||
        k === 'ArrowUp' ||
        k === 'ArrowDown' ||
        k === 'Home' ||
        k === 'End' ||
        k === 'PageUp' ||
        k === 'PageDown';
      if (!isNavKey) return;
      scheduleUpdateSelectors();
    },
    [scheduleUpdateSelectors]
  );

  const handleInputScroll = useCallback(() => {
    if (!showAtSelector) return;
    scheduleUpdateSelectors();
  }, [scheduleUpdateSelectors, showAtSelector]);

  const handleKeyPress = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    if (isComposingRef.current || (e.nativeEvent as any)?.isComposing) return;
    if (showAtSelector) return;
    if (e.shiftKey) return;
    
    e.preventDefault();
    handleSend();
  }, [handleSend, showAtSelector]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    handleKeyPress(e);
    if (e.defaultPrevented) return;

    if (showAtSelector) {
      const selectableComponentsList = getSelectableComponents();
      
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedComponentIndex(prev => 
          prev < selectableComponentsList.length - 1 ? prev + 1 : prev
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedComponentIndex(prev => prev > 0 ? prev - 1 : 0);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectableComponentsList[selectedComponentIndex]) {
          handleSelectComponent(selectableComponentsList[selectedComponentIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowAtSelector(false);
      }
    }
  }, [getSelectableComponents, handleKeyPress, handleSelectComponent, selectedComponentIndex, setSelectedComponentIndex, setShowAtSelector, showAtSelector]);

  return {
    atSelectorIndex,
    setAtSelectorIndex,
    atSelectorPosition,
    isComposingRef,
    handleInputChange,
    handleInputSelect,
    handleInputClick,
    handleInputMouseUp,
    handleInputKeyUp,
    handleInputScroll,
    handleKeyPress,
    handleKeyDown,
  };
};
