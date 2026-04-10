/**
 * 底部状态栏组件
 * 显示：Actor 池（可点击弹窗）、LLM Key、Topic 监控
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Key, MessageSquare, RefreshCw, Users } from 'lucide-react';
import { getBackendUrl } from '../utils/backendUrl';
import { Button } from '@/components/ui/Button';
import ActorPoolDialog from './ActorPoolDialog';

interface LLMKeyStatus {
  total: number;
  enabled: number;
  withKey: number;
  withoutKey: number;
}

interface TopicStatus {
  total: number;
  active: number;
  participants: number;
}

const StatusBar: React.FC = () => {
  const [llmKeyStatus, setLlmKeyStatus] = useState<LLMKeyStatus>({
    total: 0,
    enabled: 0,
    withKey: 0,
    withoutKey: 0,
  });
  const [topicStatus, setTopicStatus] = useState<TopicStatus>({
    total: 0,
    active: 0,
    participants: 0,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [backendUrl, setBackendUrl] = useState<string>('');
  const [actorPoolOpen, setActorPoolOpen] = useState(false);

  useEffect(() => {
    setBackendUrl(getBackendUrl());
  }, []);

  const checkStatus = useCallback(async () => {
    if (!backendUrl) return;

    setIsRefreshing(true);

    try {
      // 检查LLM配置和Key状态
      try {
        const llmRes = await fetch(`${backendUrl}/api/llm/configs`);
        if (llmRes.ok) {
          const llmData = await llmRes.json();
          const configs = Array.isArray(llmData) ? llmData : (llmData.configs || []);
          const enabled = configs.filter((c: any) => c.enabled);
          const withKey = enabled.filter((c: any) => {
            if (c.provider === 'ollama') return true;
            if (c.has_api_key !== undefined) return c.has_api_key === true;
            return !!c.api_key;
          });
          const withoutKey = enabled.filter((c: any) => {
            if (c.provider === 'ollama') return false;
            if (c.has_api_key !== undefined) return c.has_api_key === false;
            return !c.api_key;
          });

          setLlmKeyStatus({
            total: configs.length,
            enabled: enabled.length,
            withKey: withKey.length,
            withoutKey: withoutKey.length,
          });
        }
      } catch (error) {
        console.error('[StatusBar] Failed to fetch LLM configs:', error);
      }

      // 检查Topic状态
      try {
        const topicRes = await fetch(`${backendUrl}/api/sessions`);
        if (topicRes.ok) {
          const topicData = await topicRes.json();
          const topics = Array.isArray(topicData) ? topicData : (topicData.sessions || topicData.topics || []);
          const activeTopics = topics.filter((t: any) => {
            if (!t.last_message_at) return false;
            const lastMessageTime = new Date(t.last_message_at).getTime();
            return Date.now() - lastMessageTime < 24 * 60 * 60 * 1000;
          });

          setTopicStatus({
            total: topics.length,
            active: activeTopics.length,
            participants: 0,
          });
        }
      } catch (error) {
        console.error('[StatusBar] Failed to fetch topics:', error);
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [backendUrl]);

  useEffect(() => {
    if (backendUrl) {
      checkStatus();
      const interval = setInterval(checkStatus, 30000);
      return () => clearInterval(interval);
    }
  }, [backendUrl, checkStatus]);

  return (
    <div className="status-bar-safe fixed bottom-0 left-0 right-0 h-7 bg-gray-100 dark:bg-[#1a1a1a] border-t border-gray-200 dark:border-[#404040] flex items-center justify-between px-4 text-xs z-50">
      <div className="flex items-center gap-4">
        {/* Actor 池 - 可点击打开弹窗 */}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
          onClick={() => setActorPoolOpen(true)}
          title="查看正在工作的 Actor"
        >
          <Users className="w-3.5 h-3.5 mr-1.5" />
          Actor 池
        </Button>

        {/* LLM Key状态 */}
        <div className="flex items-center gap-1.5">
          <Key className="w-3.5 h-3.5 text-gray-500" />
          <span className="text-gray-600 dark:text-gray-400">LLM</span>
          {llmKeyStatus.withoutKey > 0 ? (
            <span className="text-yellow-500 text-xs">
              {llmKeyStatus.withKey}/{llmKeyStatus.enabled} 有Key
            </span>
          ) : llmKeyStatus.enabled > 0 ? (
            <span className="text-green-500 text-xs">
              {llmKeyStatus.enabled} 已配置
            </span>
          ) : (
            <span className="text-gray-400 text-xs">未配置</span>
          )}
        </div>

        {/* Topic监控 */}
        <div className="flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5 text-gray-500" />
          <span className="text-gray-600 dark:text-gray-400">Topic</span>
          <span className="text-gray-500 text-xs">
            {topicStatus.total} 个 / {topicStatus.active} 活跃
          </span>
        </div>
      </div>

      {/* 刷新按钮 */}
      <button
        onClick={checkStatus}
        disabled={isRefreshing}
        className="flex items-center gap-1 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors disabled:opacity-50"
        title="刷新状态"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
      </button>

      <ActorPoolDialog open={actorPoolOpen} onOpenChange={setActorPoolOpen} />
    </div>
  );
};

export default StatusBar;
