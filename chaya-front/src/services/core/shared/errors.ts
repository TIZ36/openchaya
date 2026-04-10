/**
 * Core Error Types
 * 统一的错误类型定义
 */

// ============================================================================
// Base Error - 基础错误类
// ============================================================================

/**
 * 服务错误基类
 */
export class ServiceError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly cause?: Error;
  public readonly timestamp: number;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    options: {
      retryable?: boolean;
      cause?: Error;
      context?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
    this.context = options.context;
    this.timestamp = Date.now();

    // 保持原型链
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * 转换为 JSON
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      retryable: this.retryable,
      timestamp: this.timestamp,
      context: this.context,
      cause: this.cause?.message,
    };
  }
}

// ============================================================================
// LLM Errors - LLM 相关错误
// ============================================================================

/**
 * LLM 错误代码
 */
export enum LLMErrorCode {
  PROVIDER_NOT_FOUND = 'LLM_PROVIDER_NOT_FOUND',
  AUTHENTICATION_FAILED = 'LLM_AUTHENTICATION_FAILED',
  RATE_LIMITED = 'LLM_RATE_LIMITED',
  CONTEXT_TOO_LONG = 'LLM_CONTEXT_TOO_LONG',
  INVALID_REQUEST = 'LLM_INVALID_REQUEST',
  MODEL_NOT_FOUND = 'LLM_MODEL_NOT_FOUND',
  STREAM_ERROR = 'LLM_STREAM_ERROR',
  TIMEOUT = 'LLM_TIMEOUT',
  NETWORK_ERROR = 'LLM_NETWORK_ERROR',
  UNKNOWN = 'LLM_UNKNOWN',
}

/**
 * LLM 错误
 */
export class LLMError extends ServiceError {
  public readonly provider: string;
  public readonly model?: string;
  public readonly statusCode?: number;

  constructor(
    message: string,
    provider: string,
    options: {
      code?: LLMErrorCode;
      model?: string;
      statusCode?: number;
      retryable?: boolean;
      cause?: Error;
      context?: Record<string, unknown>;
    } = {}
  ) {
    super(message, options.code ?? LLMErrorCode.UNKNOWN, {
      retryable: options.retryable ?? false,
      cause: options.cause,
      context: options.context,
    });
    this.name = 'LLMError';
    this.provider = provider;
    this.model = options.model;
    this.statusCode = options.statusCode;
  }

  /**
   * 根据 HTTP 状态码创建错误
   */
  static fromStatusCode(
    statusCode: number,
    provider: string,
    message?: string
  ): LLMError {
    let code: LLMErrorCode;
    let retryable = false;

    switch (statusCode) {
      case 401:
      case 403:
        code = LLMErrorCode.AUTHENTICATION_FAILED;
        break;
      case 429:
        code = LLMErrorCode.RATE_LIMITED;
        retryable = true;
        break;
      case 400:
        code = LLMErrorCode.INVALID_REQUEST;
        break;
      case 404:
        code = LLMErrorCode.MODEL_NOT_FOUND;
        break;
      case 408:
      case 504:
        code = LLMErrorCode.TIMEOUT;
        retryable = true;
        break;
      case 500:
      case 502:
      case 503:
        code = LLMErrorCode.NETWORK_ERROR;
        retryable = true;
        break;
      default:
        code = LLMErrorCode.UNKNOWN;
    }

    return new LLMError(
      message ?? `LLM request failed with status ${statusCode}`,
      provider,
      { code, statusCode, retryable }
    );
  }
}

// ============================================================================
// MCP Errors - MCP 相关错误
// ============================================================================

/**
 * MCP 错误代码
 */
export enum MCPErrorCode {
  CONNECTION_FAILED = 'MCP_CONNECTION_FAILED',
  CONNECTION_LOST = 'MCP_CONNECTION_LOST',
  TOOL_NOT_FOUND = 'MCP_TOOL_NOT_FOUND',
  TOOL_EXECUTION_FAILED = 'MCP_TOOL_EXECUTION_FAILED',
  INVALID_RESPONSE = 'MCP_INVALID_RESPONSE',
  TIMEOUT = 'MCP_TIMEOUT',
  POOL_EXHAUSTED = 'MCP_POOL_EXHAUSTED',
  HEALTH_CHECK_FAILED = 'MCP_HEALTH_CHECK_FAILED',
  UNKNOWN = 'MCP_UNKNOWN',
}

/**
 * MCP 错误
 */
export class MCPError extends ServiceError {
  public readonly serverId: string;
  public readonly serverName?: string;
  public readonly toolName?: string;

  constructor(
    message: string,
    serverId: string,
    options: {
      code?: MCPErrorCode;
      serverName?: string;
      toolName?: string;
      retryable?: boolean;
      cause?: Error;
      context?: Record<string, unknown>;
    } = {}
  ) {
    super(message, options.code ?? MCPErrorCode.UNKNOWN, {
      retryable: options.retryable ?? false,
      cause: options.cause,
      context: options.context,
    });
    this.name = 'MCPError';
    this.serverId = serverId;
    this.serverName = options.serverName;
    this.toolName = options.toolName;
  }
}

// ============================================================================
// Workflow Errors - 工作流相关错误
// ============================================================================

/**
 * 工作流错误代码
 */
export enum WorkflowErrorCode {
  NOT_FOUND = 'WORKFLOW_NOT_FOUND',
  INVALID_DEFINITION = 'WORKFLOW_INVALID_DEFINITION',
  EXECUTION_FAILED = 'WORKFLOW_EXECUTION_FAILED',
  NODE_FAILED = 'WORKFLOW_NODE_FAILED',
  CYCLE_DETECTED = 'WORKFLOW_CYCLE_DETECTED',
  TIMEOUT = 'WORKFLOW_TIMEOUT',
  CANCELLED = 'WORKFLOW_CANCELLED',
  UNKNOWN = 'WORKFLOW_UNKNOWN',
}

/**
 * 工作流错误
 */
export class WorkflowError extends ServiceError {
  public readonly workflowId?: string;
  public readonly nodeId?: string;

  constructor(
    message: string,
    options: {
      code?: WorkflowErrorCode;
      workflowId?: string;
      nodeId?: string;
      retryable?: boolean;
      cause?: Error;
      context?: Record<string, unknown>;
    } = {}
  ) {
    super(message, options.code ?? WorkflowErrorCode.UNKNOWN, {
      retryable: options.retryable ?? false,
      cause: options.cause,
      context: options.context,
    });
    this.name = 'WorkflowError';
    this.workflowId = options.workflowId;
    this.nodeId = options.nodeId;
  }
}

// ============================================================================
// Message Errors - 消息相关错误
// ============================================================================

/**
 * 消息错误代码
 */
export enum MessageErrorCode {
  STORE_FAILED = 'MESSAGE_STORE_FAILED',
  RETRIEVE_FAILED = 'MESSAGE_RETRIEVE_FAILED',
  INVALID_FORMAT = 'MESSAGE_INVALID_FORMAT',
  QUOTA_EXCEEDED = 'MESSAGE_QUOTA_EXCEEDED',
  UNKNOWN = 'MESSAGE_UNKNOWN',
}

/**
 * 消息错误
 */
export class MessageError extends ServiceError {
  public readonly sessionId?: string;
  public readonly messageId?: string;

  constructor(
    message: string,
    options: {
      code?: MessageErrorCode;
      sessionId?: string;
      messageId?: string;
      retryable?: boolean;
      cause?: Error;
      context?: Record<string, unknown>;
    } = {}
  ) {
    super(message, options.code ?? MessageErrorCode.UNKNOWN, {
      retryable: options.retryable ?? false,
      cause: options.cause,
      context: options.context,
    });
    this.name = 'MessageError';
    this.sessionId = options.sessionId;
    this.messageId = options.messageId;
  }
}

// ============================================================================
// Error Helpers - 错误辅助函数
// ============================================================================

/**
 * 判断是否为可重试错误
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ServiceError) {
    return error.retryable;
  }
  return false;
}

/**
 * 包装错误为 ServiceError
 */
export function wrapError(error: unknown, code: string = 'UNKNOWN'): ServiceError {
  if (error instanceof ServiceError) {
    return error;
  }
  if (error instanceof Error) {
    return new ServiceError(error.message, code, { cause: error });
  }
  return new ServiceError(String(error), code);
}

/**
 * 提取错误消息
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
