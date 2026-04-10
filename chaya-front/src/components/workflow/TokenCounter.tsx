/**
 * TokenCounter Component
 * 
 * 显示当前会话的 Token 使用情况
 */

import React from 'react';
import { estimate_messages_tokens, get_model_max_tokens } from '../../services/tokenCounter';
import { LLMConfigFromDB } from '../../services/llmApi';
import type { Message } from './types';

export interface TokenCounterProps {
  selectedLLMConfig: LLMConfigFromDB | null;
  messages: Message[];
}

export const TokenCounter: React.FC<TokenCounterProps> = ({
  selectedLLMConfig,
  messages,
}) => {
  if (!selectedLLMConfig || messages.filter(m => m.role !== 'system' && !m.isSummary).length === 0) {
    return null;
  }

  const model = selectedLLMConfig.model || 'gpt-4';
  let lastSummaryIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isSummary) {
      lastSummaryIndex = i;
      break;
    }
  }
  const messagesToCount = lastSummaryIndex >= 0 ? messages.slice(lastSummaryIndex) : messages;
  const conversationMessages = messagesToCount
    .filter(m => !(m.role === 'system' && !m.isSummary))
    .map(msg =>
      msg.isSummary
        ? { role: 'user' as const, content: msg.content, thinking: undefined }
        : { role: msg.role, content: msg.content, thinking: msg.thinking }
    );
  const currentTokens = estimate_messages_tokens(conversationMessages, model);
  const maxTokens = selectedLLMConfig?.max_tokens || get_model_max_tokens(model);
  const ratio = maxTokens > 0 ? currentTokens / maxTokens : 0;
  const formatTokens = (value: number) => {
    if (value < 1000) return value.toString();
    const scaled = value / 1000;
    const decimals = scaled < 10 ? 1 : 0;
    return `${scaled.toFixed(decimals).replace(/\.0$/, '')}k`;
  };
  const colorClass =
    ratio >= 0.9
      ? 'text-red-500 dark:text-red-400'
      : ratio >= 0.75
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-gray-400 dark:text-[#808080]';

  return (
    <span
      className={`text-[9px] truncate ${colorClass}`}
      title={`${currentTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens`}
    >
      {formatTokens(currentTokens)} / {formatTokens(maxTokens)}
    </span>
  );
};

