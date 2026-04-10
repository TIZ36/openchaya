/**
 * Voice Provider Types
 * 语音服务模块类型定义
 */

// ============================================================================
// TTS Types - 文字转语音类型
// ============================================================================

/**
 * TTS Provider 类型
 */
export type TTSProviderType = 'browser' | 'elevenlabs' | 'azure' | 'openai' | 'local';

/**
 * TTS 配置
 */
export interface TTSConfig {
  provider: TTSProviderType;
  apiKey?: string;
  apiUrl?: string;
  voice?: string;
  model?: string;
  language?: string;
  speed?: number;        // 语速 0.5-2.0
  pitch?: number;        // 音调 0.5-2.0
}

/**
 * TTS 请求参数
 */
export interface TTSRequest {
  text: string;
  voice?: string;
  model?: string;
  language?: string;
  speed?: number;
  pitch?: number;
  format?: 'mp3' | 'wav' | 'ogg' | 'opus';
}

/**
 * TTS 响应
 */
export interface TTSResponse {
  audio: Blob | ArrayBuffer;
  mimeType: string;
  duration?: number;
}

// ============================================================================
// STT Types - 语音转文字类型
// ============================================================================

/**
 * STT Provider 类型
 */
export type STTProviderType = 'browser' | 'whisper' | 'azure' | 'google' | 'local';

/**
 * STT 配置
 */
export interface STTConfig {
  provider: STTProviderType;
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  language?: string;
  continuous?: boolean;    // 是否持续识别
  interimResults?: boolean; // 是否返回中间结果
}

/**
 * STT 请求参数
 */
export interface STTRequest {
  audio: Blob | ArrayBuffer;
  language?: string;
  model?: string;
  prompt?: string;         // 上下文提示
}

/**
 * STT 响应
 */
export interface STTResponse {
  text: string;
  confidence?: number;
  language?: string;
  segments?: Array<{
    text: string;
    start: number;
    end: number;
    confidence?: number;
  }>;
}

/**
 * STT 流式回调
 */
export interface STTStreamCallbacks {
  onInterim?: (text: string) => void;
  onFinal?: (result: STTResponse) => void;
  onError?: (error: Error) => void;
}

// ============================================================================
// Voice Clone Types - 声音克隆类型
// ============================================================================

/**
 * 声音克隆配置
 */
export interface VoiceCloneConfig {
  provider: 'elevenlabs' | 'azure' | 'local';
  apiKey?: string;
  apiUrl?: string;
}

/**
 * 声音克隆请求
 */
export interface VoiceCloneRequest {
  name: string;
  description?: string;
  samples: Array<Blob | ArrayBuffer>;
  labels?: Record<string, string>;
}

/**
 * 克隆的声音
 */
export interface ClonedVoice {
  id: string;
  name: string;
  description?: string;
  previewUrl?: string;
  createdAt: number;
}

// ============================================================================
// Provider Interfaces
// ============================================================================

/**
 * TTS Provider 接口
 */
export interface ITTSProvider {
  readonly type: TTSProviderType;
  synthesize(request: TTSRequest): Promise<TTSResponse>;
  getVoices(): Promise<string[]>;
}

/**
 * STT Provider 接口
 */
export interface ISTTProvider {
  readonly type: STTProviderType;
  transcribe(request: STTRequest): Promise<STTResponse>;
  startStreaming?(callbacks: STTStreamCallbacks): void;
  stopStreaming?(): void;
}

/**
 * Voice Clone Provider 接口
 */
export interface IVoiceCloneProvider {
  clone(request: VoiceCloneRequest): Promise<ClonedVoice>;
  listVoices(): Promise<ClonedVoice[]>;
  deleteVoice(voiceId: string): Promise<void>;
}
