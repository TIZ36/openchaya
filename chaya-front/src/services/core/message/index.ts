/**
 * Message Module
 * 消息模块统一导出
 */

// Types
export * from './types';

// WriteBuffer
export { WriteBuffer } from './WriteBuffer';

// AsyncPersist
export { AsyncPersist } from './AsyncPersist';

// MessageStore
export {
  MessageStore,
  getMessageStore,
  initMessageStore,
  type MessageStoreStatus,
} from './MessageStore';

// MessageManager - 高效消息获取和缓存管理
export {
  MessageManager,
  createMessageManager,
  type MessageManagerOptions,
  type MessageState,
  type MediaState,
} from './MessageManager';

// React Hooks
export {
  useMessageManager,
  useMediaMessages,
  type UseMessageManagerResult,
  type UseMediaMessagesResult,
} from './useMessageManager';
