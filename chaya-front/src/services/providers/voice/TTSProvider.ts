/**
 * TTSProvider - 文字转语音服务
 */

import type {
  TTSConfig,
  TTSProviderType,
  TTSRequest,
  TTSResponse,
  ITTSProvider,
} from './types';
import { createLogger } from '../../core/shared/utils';

const logger = createLogger('TTSProvider');

/**
 * 浏览器原生 TTS Provider
 */
export class BrowserTTSProvider implements ITTSProvider {
  readonly type: TTSProviderType = 'browser';
  private synthesis: SpeechSynthesis;

  constructor() {
    this.synthesis = window.speechSynthesis;
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(request.text);

      if (request.voice) {
        const voices = this.synthesis.getVoices();
        const voice = voices.find((v) => v.name === request.voice);
        if (voice) utterance.voice = voice;
      }

      if (request.language) utterance.lang = request.language;
      if (request.speed) utterance.rate = request.speed;
      if (request.pitch) utterance.pitch = request.pitch;

      // 浏览器 TTS 不返回音频数据，只播放
      utterance.onend = () => {
        resolve({
          audio: new Blob(), // 空 Blob
          mimeType: 'audio/wav',
        });
      };

      utterance.onerror = (event) => {
        reject(new Error(`TTS error: ${event.error}`));
      };

      this.synthesis.speak(utterance);
    });
  }

  async getVoices(): Promise<string[]> {
    return this.synthesis.getVoices().map((v) => v.name);
  }
}

/**
 * OpenAI TTS Provider
 */
export class OpenAITTSProvider implements ITTSProvider {
  readonly type: TTSProviderType = 'openai';
  private config: TTSConfig;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const url = this.config.apiUrl || 'https://api.openai.com/v1/audio/speech';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model || this.config.model || 'tts-1',
        input: request.text,
        voice: request.voice || this.config.voice || 'alloy',
        response_format: request.format || 'mp3',
        speed: request.speed || this.config.speed || 1.0,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI TTS error: ${response.status}`);
    }

    const audio = await response.blob();

    return {
      audio,
      mimeType: `audio/${request.format || 'mp3'}`,
    };
  }

  async getVoices(): Promise<string[]> {
    return ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  }
}

/**
 * 创建 TTS Provider
 */
export function createTTSProvider(config: TTSConfig): ITTSProvider {
  switch (config.provider) {
    case 'browser':
      return new BrowserTTSProvider();
    case 'openai':
      return new OpenAITTSProvider(config);
    default:
      logger.warn('Unknown TTS provider, using browser', { provider: config.provider });
      return new BrowserTTSProvider();
  }
}
