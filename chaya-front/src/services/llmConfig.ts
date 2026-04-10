/**
 * LLM配置管理服务
 * 用于存储和管理LLM API配置
 */

export interface LLMConfig {
  id: string;
  provider: 'openai' | 'anthropic' | 'ollama' | 'local' | 'custom' | 'gemini' | 'deepseek';
  name: string;
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  enabled: boolean;
  metadata?: Record<string, any>;
}

class LLMConfigManager {
  private configs: LLMConfig[] = [];
  private currentConfigId: string | null = null;

  /**
   * 从存储加载配置
   */
  loadConfigs(): void {
    try {
      const stored = localStorage.getItem('llm_configs');
      if (stored) {
        this.configs = JSON.parse(stored);
      }
      
      const currentId = localStorage.getItem('current_llm_config_id');
      if (currentId) {
        this.currentConfigId = currentId;
      }
    } catch (error) {
      console.error('[LLM Config] Failed to load configs:', error);
      this.configs = [];
    }
  }

  /**
   * 保存配置到存储
   */
  saveConfigs(): void {
    try {
      localStorage.setItem('llm_configs', JSON.stringify(this.configs));
      if (this.currentConfigId) {
        localStorage.setItem('current_llm_config_id', this.currentConfigId);
      }
    } catch (error) {
      console.error('[LLM Config] Failed to save configs:', error);
    }
  }

  /**
   * 获取所有配置
   */
  getAllConfigs(): LLMConfig[] {
    return this.configs;
  }

  /**
   * 获取当前激活的配置
   */
  getCurrentConfig(): LLMConfig | null {
    if (!this.currentConfigId) {
      return null;
    }
    return this.configs.find(c => c.id === this.currentConfigId) || null;
  }

  /**
   * 添加配置
   */
  addConfig(config: LLMConfig): void {
    this.configs.push(config);
    this.saveConfigs();
  }

  /**
   * 更新配置
   */
  updateConfig(id: string, updates: Partial<LLMConfig>): void {
    const index = this.configs.findIndex(c => c.id === id);
    if (index !== -1) {
      this.configs[index] = { ...this.configs[index], ...updates };
      this.saveConfigs();
    }
  }

  /**
   * 删除配置
   */
  removeConfig(id: string): void {
    this.configs = this.configs.filter(c => c.id !== id);
    if (this.currentConfigId === id) {
      this.currentConfigId = null;
      localStorage.removeItem('current_llm_config_id');
    }
    this.saveConfigs();
  }

  /**
   * 设置当前配置
   */
  setCurrentConfig(id: string | null): void {
    this.currentConfigId = id;
    this.saveConfigs();
  }
}

export const llmConfigManager = new LLMConfigManager();

// 初始化时加载配置
if (typeof window !== 'undefined') {
  llmConfigManager.loadConfigs();
}

