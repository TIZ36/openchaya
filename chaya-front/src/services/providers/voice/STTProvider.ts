/**
 * STTProvider - 语音转文字服务
 */

import type {
  STTConfig,
  STTProviderType,
  STTRequest,
  STTResponse,
  STTStreamCallbacks,
  ISTTProvider,
} from './types';
import { createLogger } from '../../core/shared/utils';

const logger = createLogger('STTProvider');

/**
 * 浏览器原生 STT Provider
 */
export class BrowserSTTProvider implements ISTTProvider {
  readonly type: STTProviderType = 'browser';
  private recognition: any; // SpeechRecognition
  private callbacks?: STTStreamCallbacks;

  constructor(config?: STTConfig) {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      throw new Error('Speech recognition not supported');
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = config?.continuous ?? false;
    this.recognition.interimResults = config?.interimResults ?? true;
    this.recognition.lang = config?.language || 'zh-CN';

    this.recognition.onresult = (event: any) => {
      const result = event.results[event.results.length - 1];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        this.callbacks?.onFinal?.({
          text: transcript,
          confidence: result[0].confidence,
        });
      } else {
        this.callbacks?.onInterim?.(transcript);
      }
    };

    this.recognition.onerror = (event: any) => {
      this.callbacks?.onError?.(new Error(event.error));
    };
  }

  async transcribe(_request: STTRequest): Promise<STTResponse> {
    // 浏览器 STT 不支持离线转录
    throw new Error('Browser STT does not support offline transcription');
  }

  startStreaming(callbacks: STTStreamCallbacks): void {
    this.callbacks = callbacks;
    this.recognition.start();
  }

  stopStreaming(): void {
    this.recognition.stop();
    this.callbacks = undefined;
  }
}

/**
 * Whisper STT Provider
 */
export class WhisperSTTProvider implements ISTTProvider {
  readonly type: STTProviderType = 'whisper';
  private config: STTConfig;

  constructor(config: STTConfig) {
    this.config = config;
  }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const url = this.config.apiUrl || 'https://api.openai.com/v1/audio/transcriptions';

    const formData = new FormData();
    formData.append('file', request.audio as Blob, 'audio.webm');
    formData.append('model', request.model || this.config.model || 'whisper-1');
    
    if (request.language) {
      formData.append('language', request.language);
    }
    if (request.prompt) {
      formData.append('prompt', request.prompt);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Whisper STT error: ${response.status}`);
    }

    const data = await response.json();

    return {
      text: data.text,
      language: data.language,
      segments: data.segments?.map((s: any) => ({
        text: s.text,
        start: s.start,
        end: s.end,
      })),
    };
  }
}

/**
 * 创建 STT Provider
 */
export function createSTTProvider(config: STTConfig): ISTTProvider {
  switch (config.provider) {
    case 'browser':
      return new BrowserSTTProvider(config);
    case 'whisper':
      return new WhisperSTTProvider(config);
    default:
      logger.warn('Unknown STT provider, using browser', { provider: config.provider });
      return new BrowserSTTProvider(config);
  }
}
