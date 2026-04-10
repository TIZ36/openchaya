/**
 * Data Parser Utilities
 * Helper functions to extract structured data (JSON, URLs) from raw text strings.
 */

/**
 * Tries to parse a string as JSON.
 * Handles markdown code blocks (e.g. ```json ... ```).
 */
export function tryParseJson(text: string): any | null {
  if (!text) return null;

  try {
    // 1. Try direct parsing
    return JSON.parse(text);
  } catch (e) {
    // 2. Try extracting from markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (e2) {
        // console.warn('Failed to parse extracted JSON block', e2);
      }
    }

    // 3. Try finding the first { or [ and the last } or ]
    // This is a heuristic for when LLMs mix text and JSON without code blocks
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    const lastBrace = text.lastIndexOf('}');
    const lastBracket = text.lastIndexOf(']');

    let start = -1;
    let end = -1;

    // Determine if object or array starts first
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      start = firstBrace;
    } else if (firstBracket !== -1) {
      start = firstBracket;
    }

    // Determine if object or array ends last
    if (lastBrace !== -1 && (lastBracket === -1 || lastBrace > lastBracket)) {
      end = lastBrace;
    } else if (lastBracket !== -1) {
      end = lastBracket;
    }

    if (start !== -1 && end !== -1 && end > start) {
      const candidate = text.substring(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch (e3) {
        // console.warn('Failed to parse heuristic JSON candidate', e3);
      }
    }

    return null;
  }
}

/**
 * Checks if a string is a valid URL.
 */
export function isValidUrl(text: string): boolean {
  if (!text) return false;
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/**
 * Extracts the first valid URL from a string.
 */
export function extractUrl(text: string): string | null {
  if (!text) return null;
  
  // Simple regex for URLs
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const match = text.match(urlRegex);
  return match ? match[0] : null;
}

/**
 * Detects the likely type of data in a string.
 * Returns 'json-array', 'json-object', 'weblink', or 'text'.
 */
export function detectDataType(text: string): 'json-array' | 'json-object' | 'weblink' | 'text' {
  if (isValidUrl(text.trim())) {
    return 'weblink';
  }

  const json = tryParseJson(text);
  if (json) {
    if (Array.isArray(json)) {
      return 'json-array';
    } else if (typeof json === 'object' && json !== null) {
      return 'json-object';
    }
  }

  return 'text';
}