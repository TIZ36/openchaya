import React, { createContext, useContext, useRef, useCallback, useState, useEffect } from 'react';

// 终端标签颜色选项
export const TAB_COLORS = [
  { name: '默认', value: null },
  { name: '红色', value: '#ef4444' },
  { name: '橙色', value: '#f97316' },
  { name: '黄色', value: '#eab308' },
  { name: '绿色', value: '#22c55e' },
  { name: '青色', value: '#06b6d4' },
  { name: '蓝色', value: '#3b82f6' },
  { name: '紫色', value: '#8b5cf6' },
  { name: '粉色', value: '#ec4899' },
];

// 终端会话类型
export interface TerminalSession {
  id: string;
  name: string;
  color: string | null; // 标签颜色
  ptyPid: number | null;
  createdAt: number;
}

// 命令历史记录
export interface CommandHistoryEntry {
  command: string;
  timestamp: number;
  sessionId: string;
}

// LLM 配置
export interface TerminalLLMConfig {
  enabled: boolean;
  configId: string | null;
}

interface TerminalContextType {
  // 会话管理
  sessions: TerminalSession[];
  activeSessionId: string | null;
  addSession: () => string;
  removeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  setSessionColor: (sessionId: string, color: string | null) => void;
  
  // 命令执行
  executeCommand: (command: string, sessionId?: string) => void;
  setTerminalRef: (ref: { executeCommand: (command: string) => void } | null, sessionId: string) => void;
  
  // 命令历史
  commandHistory: CommandHistoryEntry[];
  addCommandToHistory: (command: string, sessionId: string) => void;
  getRecentCommands: (count?: number) => string[];
  
  // LLM 补全
  llmConfig: TerminalLLMConfig;
  setLLMConfig: (config: TerminalLLMConfig) => void;
  
  // PTY 管理
  setPtyPid: (sessionId: string, pid: number | null) => void;
  getPtyPid: (sessionId: string) => number | null;
}

const TerminalContext = createContext<TerminalContextType | null>(null);

// localStorage keys
const STORAGE_KEYS = {
  SESSIONS: 'terminal_sessions',
  ACTIVE_SESSION: 'terminal_active_session',
  COMMAND_HISTORY: 'terminal_command_history',
  LLM_CONFIG: 'terminal_llm_config',
};

// 生成唯一 ID
const generateId = () => `term_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export const TerminalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 终端引用映射 (sessionId -> ref)
  const terminalRefs = useRef<Map<string, { executeCommand: (command: string) => void } | null>>(new Map());
  
  // 会话状态 - 从 localStorage 恢复
  const [sessions, setSessions] = useState<TerminalSession[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.SESSIONS);
      if (stored) {
        const parsed = JSON.parse(stored);
        // 恢复会话但清除 PTY PID（需要重新创建）
        return parsed.map((s: TerminalSession) => ({ ...s, ptyPid: null }));
      }
    } catch (e) {
      console.error('Failed to restore terminal sessions:', e);
    }
    return [];
  });
  
  // 活动会话 ID
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION);
    } catch (e) {
      return null;
    }
  });
  
  // 命令历史 - 从 localStorage 恢复
  const [commandHistory, setCommandHistory] = useState<CommandHistoryEntry[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.COMMAND_HISTORY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.error('Failed to restore command history:', e);
    }
    return [];
  });
  
  // LLM 配置 - 从 localStorage 恢复
  const [llmConfig, setLLMConfigState] = useState<TerminalLLMConfig>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.LLM_CONFIG);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.error('Failed to restore LLM config:', e);
    }
    return { enabled: false, configId: null };
  });
  
  // 持久化会话到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify(sessions));
    } catch (e) {
      console.error('Failed to save terminal sessions:', e);
    }
  }, [sessions]);
  
  // 持久化活动会话
  useEffect(() => {
    try {
      if (activeSessionId) {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, activeSessionId);
      } else {
        localStorage.removeItem(STORAGE_KEYS.ACTIVE_SESSION);
      }
    } catch (e) {
      console.error('Failed to save active session:', e);
    }
  }, [activeSessionId]);
  
  // 持久化命令历史（限制条数）
  useEffect(() => {
    try {
      // 只保留最近 100 条
      const limitedHistory = commandHistory.slice(-100);
      localStorage.setItem(STORAGE_KEYS.COMMAND_HISTORY, JSON.stringify(limitedHistory));
    } catch (e) {
      console.error('Failed to save command history:', e);
    }
  }, [commandHistory]);
  
  // 持久化 LLM 配置
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.LLM_CONFIG, JSON.stringify(llmConfig));
    } catch (e) {
      console.error('Failed to save LLM config:', e);
    }
  }, [llmConfig]);

  // 添加新会话
  const addSession = useCallback(() => {
    const id = generateId();
    setSessions(prev => {
      const newSession: TerminalSession = {
        id,
        name: `终端 ${prev.length + 1}`,
        color: null,
        ptyPid: null,
        createdAt: Date.now(),
      };
      return [...prev, newSession];
    });
    setActiveSessionId(id);
    return id;
  }, []);
  
  // 移除会话
  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const newSessions = prev.filter(s => s.id !== sessionId);
      // 如果删除的是活动会话，切换到最后一个会话
      if (activeSessionId === sessionId) {
        const lastSession = newSessions[newSessions.length - 1];
        setActiveSessionId(lastSession?.id || null);
      }
      return newSessions;
    });
    // 清理终端引用
    terminalRefs.current.delete(sessionId);
  }, [activeSessionId]);
  
  // 设置活动会话
  const setActiveSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
  }, []);
  
  // 重命名会话
  const renameSession = useCallback((sessionId: string, name: string) => {
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, name } : s
    ));
  }, []);
  
  // 设置会话颜色
  const setSessionColor = useCallback((sessionId: string, color: string | null) => {
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, color } : s
    ));
  }, []);

  // 执行命令
  const executeCommand = useCallback((command: string, sessionId?: string) => {
    const targetSessionId = sessionId || activeSessionId;
    if (!targetSessionId) return;
    
    const ref = terminalRefs.current.get(targetSessionId);
    if (ref) {
      ref.executeCommand(command);
    }
  }, [activeSessionId]);

  // 设置终端引用
  const setTerminalRef = useCallback((ref: { executeCommand: (command: string) => void } | null, sessionId: string) => {
    if (ref) {
      terminalRefs.current.set(sessionId, ref);
    } else {
      terminalRefs.current.delete(sessionId);
    }
  }, []);
  
  // 添加命令到历史
  const addCommandToHistory = useCallback((command: string, sessionId: string) => {
    if (!command.trim()) return;
    
    setCommandHistory(prev => {
      // 避免重复添加相同的最后一条命令
      if (prev.length > 0 && prev[prev.length - 1].command === command) {
        return prev;
      }
      return [...prev, {
        command,
        timestamp: Date.now(),
        sessionId,
      }];
    });
  }, []);
  
  // 获取最近的命令（用于 LLM 上下文）
  const getRecentCommands = useCallback((count: number = 20) => {
    return commandHistory
      .slice(-count)
      .map(entry => entry.command);
  }, [commandHistory]);
  
  // 设置 LLM 配置
  const setLLMConfig = useCallback((config: TerminalLLMConfig) => {
    setLLMConfigState(config);
  }, []);
  
  // 设置 PTY PID
  const setPtyPid = useCallback((sessionId: string, pid: number | null) => {
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, ptyPid: pid } : s
    ));
  }, []);
  
  // 获取 PTY PID
  const getPtyPid = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    return session?.ptyPid || null;
  }, [sessions]);

  return (
    <TerminalContext.Provider value={{ 
      sessions,
      activeSessionId,
      addSession,
      removeSession,
      setActiveSession,
      renameSession,
      setSessionColor,
      executeCommand, 
      setTerminalRef,
      commandHistory,
      addCommandToHistory,
      getRecentCommands,
      llmConfig,
      setLLMConfig,
      setPtyPid,
      getPtyPid,
    }}>
      {children}
    </TerminalContext.Provider>
  );
};

export const useTerminal = () => {
  const context = useContext(TerminalContext);
  if (!context) {
    throw new Error('useTerminal must be used within TerminalProvider');
  }
  return context;
};
