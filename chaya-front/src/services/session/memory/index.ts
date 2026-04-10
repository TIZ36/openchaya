/**
 * Memory Module
 * 记忆模块统一导出
 */

export {
  MemoryStore,
  type MemoryStoreConfig,
  DEFAULT_MEMORY_STORE_CONFIG,
} from './MemoryStore';

export {
  MemoryRetrieval,
  type RetrievalConfig,
  type EmbeddingGenerator,
  DEFAULT_RETRIEVAL_CONFIG,
} from './MemoryRetrieval';

export {
  MemoryConsolidation,
  type ConsolidationConfig,
  type ConsolidationResult,
  DEFAULT_CONSOLIDATION_CONFIG,
} from './MemoryConsolidation';
