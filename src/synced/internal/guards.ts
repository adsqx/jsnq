/**
 * Shared runtime guards: object checks, numeric-segment checks, the single prototype-pollution
 * segment blocklist and the array-insert helper. Pure; no side effects beyond the blocklist Set.
 * Safe to import from data-engine.
 */

/** An object/array/function node the engine may read or write into. */
export type JsonContainer = Record<string, unknown>;

/** Own-property test that also works on prototype-less objects. */
export const hasOwn = (obj: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/** Non-null object (arrays included). */
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Non-null, non-array object. */
export const isRecordObject = (v: unknown): v is Record<string, unknown> => isObject(v) && !Array.isArray(v);

/** Non-null object OR function (data-engine treats callables as traversable containers). */
export const isObjectLike = (v: unknown): v is JsonContainer => v !== null && (typeof v === 'object' || typeof v === 'function');

/**
 * True for a non-empty string made only of ASCII digits 0-9; false for `''`, `'-1'`, `'1e3'`,
 * `'1.5'`, null and undefined. Char-scan, equivalent to `/^\d+$/.test(s)` for every string.
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

/** True for a forbidden name. The length test is a cheap pre-filter: the names are 9 or 11 characters, so ordinary keys skip the Set lookup. */
export function isForbiddenSegment(segment: string): boolean {
  const n = segment.length;
  return (n === 9 || n === 11) && FORBIDDEN_SEGMENTS.has(segment);
}

/** Like {@link isForbiddenSegment} but accepts numbers/null/undefined (coerced with `String`; nullish is never forbidden). */
export function isForbiddenKey(key: string | number | null | undefined): boolean {
  return key !== undefined && key !== null && FORBIDDEN_SEGMENTS.has(String(key));
}

/** Throws `Unsafe path segment in '<path>'` when any segment is forbidden. */
export function assertSafeSegments(segments: readonly string[], path: string): void {
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) throw new Error(`Unsafe path segment in '${path}'`);
  }
}

/**
 * Insert one `item` at `index` clamped into `[0, arr.length]` (no deletion): negative indices
 * clamp to 0 (native `splice` would count from the end). Single-item on purpose: a
 * rest-parameter form measured ~2x slower on the insert hot path.
 */
export function spliceClamped<T>(arr: T[], index: number, item: T): void {
  arr.splice(index < 0 ? 0 : index, 0, item);
}
