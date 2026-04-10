/**
 * Persona Module
 * 拟真模块统一导出
 */

export { VoicePersonaManager } from './VoicePersona';

export { AutonomousThinking, type ThinkingHandler } from './AutonomousThinking';

export {
  MemoryTrigger,
  type TriggerRule,
  type TriggerResult,
  createImportantMemoryRule,
  createRecentMemoryRule,
  createKeywordTriggerRule,
} from './MemoryTrigger';
