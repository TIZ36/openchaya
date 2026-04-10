import React, { useRef } from 'react';
import type { Message } from './types';
import { LLMClient, LLMMessage } from '../../services/llmClient';
import { saveMessage, createSession, updateSessionAvatar, updateSessionName, updateSessionSystemPrompt, updateSessionMediaOutputPath, updateSessionLLMConfig, Session } from '../../services/chat';
import { mcpManager } from '../../services/mcpClient';
import { workflowPool } from '../../services/workflowPool';

export interface MessageSendingProps {
  sessionId: string | null;
  input: string;
  setInput: (value: string) => void;
  attachedMedia: any[];
  setAttachedMedia: (media: any[]) => void;
  quotedMessageId: string | null;
  setQuotedMessageId: (id: string | null) => void;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  selectedLLMConfigId: string | null;
  selectedLLMConfig: any;
  currentSystemPrompt: string | null;
  mcpServers: any[];
  workflows: any[];
  allSkillPacks: any[];
  currentSessionSkillPacks: any[];
  setIsLoading: (loading: boolean) => void;
  setCollapsedThinking: React.Dispatch<React.SetStateAction<Set<string>>>;
  lastRequestRef: React.MutableRefObject<any>;
  currentSessionMeta: Session | null;
  setCurrentSessionId: (id: string | null) => void;
  loadSessions: () => Promise<void>;
  onSelectSession?: (sessionId: string) => void;
  streamEnabled: boolean;
  enableThinking: boolean;
}

export const useMessageSending = ({
  sessionId,
  input,
  setInput,
  attachedMedia,
  setAttachedMedia,
  quotedMessageId,
  setQuotedMessageId,
  messages,
  setMessages,
  selectedLLMConfigId,
  selectedLLMConfig,
  currentSystemPrompt,
  mcpServers,
  workflows,
  allSkillPacks,
  currentSessionSkillPacks,
  setIsLoading,
  setCollapsedThinking,
  lastRequestRef,
  currentSessionMeta,
  setCurrentSessionId,
  loadSessions,
  onSelectSession,
  streamEnabled,
  enableThinking,
}: MessageSendingProps) => {
  // Logic will go here
};
