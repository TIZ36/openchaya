/**
 * Research Module
 * 研究助手模块统一导出
 */

export {
  DocumentGenerator,
  type DocumentFormat,
  type DocumentSection,
  type Document,
} from './DocumentGenerator';

export {
  ResearchOrchestrator,
  type ResearchPhase,
  type ResearchConfig,
  type ResearchRecord,
  type ResearchFinding,
  DEFAULT_RESEARCH_CONFIG,
} from './ResearchOrchestrator';
