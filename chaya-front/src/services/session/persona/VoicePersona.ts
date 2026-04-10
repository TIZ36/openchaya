/**
 * VoicePersona - 语音人设管理
 * 管理 Agent 的声音特征
 */

import type { VoicePersona as VoicePersonaType } from '../types';
import { createTTSProvider, type TTSConfig, type TTSResponse } from '../../providers/voice';
import { createLogger } from '../../core/shared/utils';

const logger = createLogger('VoicePersona');

/**
 * 语音人设管理器
 */
export class VoicePersonaManager {
  private agentId: string;
  private persona?: VoicePersonaType;
  private ttsConfig?: TTSConfig;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /**
   * 设置语音人设
   */
  setPersona(persona: VoicePersonaType, ttsConfig: TTSConfig): void {
    this.persona = persona;
    this.ttsConfig = ttsConfig;
    
    logger.info('Voice persona set', {
      agentId: this.agentId,
      voiceId: persona.voiceId,
      name: persona.name,
    });
  }

  /**
   * 获取语音人设
   */
  getPersona(): VoicePersonaType | undefined {
    return this.persona;
  }

  /**
   * 合成语音
   */
  async speak(text: string): Promise<TTSResponse | null> {
    if (!this.persona || !this.ttsConfig) {
      logger.warn('Voice persona not configured', { agentId: this.agentId });
      return null;
    }

    try {
      const provider = createTTSProvider(this.ttsConfig);
      
      const response = await provider.synthesize({
        text,
        voice: this.persona.voiceId,
        language: this.persona.language,
      });

      logger.debug('Speech synthesized', {
        agentId: this.agentId,
        textLength: text.length,
      });

      return response;
    } catch (error) {
      logger.error('Speech synthesis failed', {
        agentId: this.agentId,
        error,
      });
      return null;
    }
  }

  /**
   * 检查是否启用语音
   */
  isEnabled(): boolean {
    return !!this.persona && !!this.ttsConfig;
  }

  /**
   * 清除语音人设
   */
  clear(): void {
    this.persona = undefined;
    this.ttsConfig = undefined;
  }
}
