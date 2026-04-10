/**
 * 全局终端命令执行器
 * 用于从任何地方执行终端命令
 */

let executeCommandFn: ((command: string) => void) | null = null;

export const setTerminalExecutor = (fn: ((command: string) => void) | null) => {
  executeCommandFn = fn;
};

export const executeTerminalCommand = (command: string) => {
  if (executeCommandFn) {
    executeCommandFn(command);
  } else {
    console.warn('Terminal executor not ready. Command:', command);
  }
};









