/**
 * Shared runtime guards: object checks, numeric-segment checks and the single
 * prototype-pollution segment blocklist. Pure, no module-level side effects
 * beyond the frozen-by-convention blocklist Set. Safe to import from data-engine.
 */

/** Non-null object (arrays included). */
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Non-null, non-array object. */
export const isRecordObject = (v: unknown): v is Record<string, unknown> => isObject(v) && !Array.isArray(v);

/** Non-null object OR function (data-engine treats callables as traversable containers). */
export const isObjectLike = (v: unknown): v is Record<string, unknown> =>
  v !== null && (typeof v === 'object' || typeof v === 'function');

/**
 * True for a non-empty string made only of ASCII digits 0-9 (`'0'`, `'01'`, `'42'`);
 * false for `''`, `'-1'`, `'1e3'`, `'1.5'`, null and undefined. Char-scan; equivalent
 * to `/^\d+$/.test(s)` for every string (JS `\d` is ASCII-only and `$` has no
 * trailing-newline allowance), so it replaces both former duplicates.
 */
export function isNumericSegment(segment: string | null | undefined): boolean {
  if (!segment) return false;
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** Path segments / object keys that must never be traversed or written (prototype pollution). */
export const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * True when `segment` is a forbidden name. The length test is a cheap pre-filter: the
 * three forbidden names are 9 or 11 characters, so ordinary keys skip the Set lookup.
 */
export function isForbiddenSegment(segment: string): boolean {
  const n = segment.length;
  return (n === 9 || n === 11) && FORBIDDEN_SEGMENTS.has(segment);
}

/** Like {@link isForbiddenSegment} but accepts numbers/null/undefined (coerced with `String`; nullish is never forbidden). */
export function isForbiddenKey(key: string | number | null | undefined): boolean {
  return key !== undefined && key !== null && FORBIDDEN_SEGMENTS.has(String(key));
}

/** True when any element (coerced with `String`) is a forbidden name. */
export function hasForbiddenSegment(segments: readonly unknown[]): boolean {
  return segments.some((segment) => FORBIDDEN_SEGMENTS.has(String(segment)));
}

/** Throws `Unsafe path segment in '<path>'` when any segment is forbidden. */
export function assertSafeSegments(segments: readonly string[], path: string): void {
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) throw new Error(`Unsafe path segment in '${path}'`);
  }
}
