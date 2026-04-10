export const SESSIONS_CHANGED_EVENT = 'sessions-changed';

export function emitSessionsChanged(): void {
  try {
    window.dispatchEvent(new Event(SESSIONS_CHANGED_EVENT));
  } catch {
    // ignore
  }
}

