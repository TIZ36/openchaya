/** localStorage：极速 / Harness 模式（与 WS ext.response_mode fast|precise 对齐） */
export const PRECISE_MODE_LS_KEY = 'chatee_precise_mode';

export function readPreciseMode(): boolean {
  try {
    return localStorage.getItem(PRECISE_MODE_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writePreciseMode(precise: boolean): void {
  try {
    localStorage.setItem(PRECISE_MODE_LS_KEY, precise ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}
