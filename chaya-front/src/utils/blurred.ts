/**
 * Per-output "covered" flag. Persists in localStorage keyed by output_id so a
 * tile the user covered in Create stays covered next session, and the same
 * output rendered elsewhere (chat gallery picker, message attachments) can
 * honor the same setting.
 */

const LS_BLURRED_OUTPUTS = 'chaya_blurred_outputs';

export function loadBlurredSet(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_BLURRED_OUTPUTS);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch { return new Set(); }
}

export function saveBlurredSet(set: Set<string>): void {
  try {
    localStorage.setItem(LS_BLURRED_OUTPUTS, JSON.stringify(Array.from(set)));
  } catch { /* ignore */ }
}

export function isBlurred(outputId: string | undefined | null): boolean {
  if (!outputId) return false;
  return loadBlurredSet().has(outputId);
}

/** CSS for a covered image. Use with `transform: scale(1.06)` to hide edges. */
export const BLURRED_IMG_CSS = {
  filter: 'blur(14px) saturate(0.85)',
  transform: 'scale(1.06)',
  transition: 'filter 200ms ease, transform 200ms ease',
} as const;
