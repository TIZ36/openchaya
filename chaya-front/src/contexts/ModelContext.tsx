/**
 * 模型状态Context
 * 用于在应用顶部Banner中显示当前模型和流式输出状态
 */

import React, { createContext, useContext, useState, ReactNode } from 'react';
import { LLMConfigFromDB } from '../services/llmApi';

interface ModelContextType {
  currentModel: LLMConfigFromDB | null;
  streamEnabled: boolean;
  setCurrentModel: (model: LLMConfigFromDB | null) => void;
  setStreamEnabled: (enabled: boolean) => void;
}

const ModelContext = createContext<ModelContextType | undefined>(undefined);

export const ModelProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentModel, setCurrentModel] = useState<LLMConfigFromDB | null>(null);
  const [streamEnabled, setStreamEnabled] = useState<boolean>(true);

  return (
    <ModelContext.Provider value={{ currentModel, streamEnabled, setCurrentModel, setStreamEnabled }}>
      {children}
    </ModelContext.Provider>
  );
};

export const useModel = () => {
  const context = useContext(ModelContext);
  if (context === undefined) {
    throw new Error('useModel must be used within a ModelProvider');
  }
  return context;
};

