import { useEffect, useRef } from 'react';
import { Message } from '../components/workflow/types';
import { synthesizeText, TTSSettings } from './ttsApi';

export interface UseTTSGenerationOptions {
  enabled: boolean;
  voiceId: string;
  settings?: TTSSettings;
}

export interface UseTTSGenerationResult {
  generatingMessageId: string | null;
  audioBlob: Blob | null;
  error: string | null;
}

export const useTTSGeneration = (
  message: Message,
  options: UseTTSGenerationOptions,
  onAudioGenerated?: (messageId: string, blob: Blob) => void
): UseTTSGenerationResult => {
  const generatingRef = useRef<string | null>(null);
  const audioRef = useRef<Blob | null>(null);
  const errorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!options.enabled || !options.voiceId) {
      return;
    }

    if (message.role !== 'assistant' || !message.content || message.content.length === 0) {
      return;
    }

    if (message.isStreaming || message.isThinking) {
      return;
    }

    const generateTTS = async () => {
      try {
        generatingRef.current = message.id;
        errorRef.current = null;

        const audioBlob = await synthesizeText(
          message.content,
          options.voiceId,
          options.settings
        );

        audioRef.current = audioBlob;
        if (onAudioGenerated) {
          onAudioGenerated(message.id, audioBlob);
        }
      } catch (err) {
        errorRef.current = err instanceof Error ? err.message : 'Failed to generate speech';
        console.error('TTS generation error:', errorRef.current);
      } finally {
        generatingRef.current = null;
      }
    };

    generateTTS();
  }, [message.id, message.role, message.content, message.isStreaming, message.isThinking, options.enabled, options.voiceId, options.settings, onAudioGenerated]);

  return {
    generatingMessageId: generatingRef.current,
    audioBlob: audioRef.current,
    error: errorRef.current,
  };
};
