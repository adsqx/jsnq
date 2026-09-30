/**
 * Thin string-path helpers over the engine's shared, bounded plan cache, so path parsing
 * behaves (and performs) identically in every host project. Re-exported by core/utils.
 */
import {
  cloneJsonData,
  createJsonPathPlan,
  deleteJsonPath,
  getJsonBySegments,
  hasJsonPath,
  setJsonPlanCacheLimit,
  writeJsonPath,
} from '../core/data-engine';
import { isNumericSegment } from './guards';

/** Parses `path` into a fresh, mutable segment array (`''` -> `[]`). */
export const splitPath = (path: string): string[] => (path ? [...createJsonPathPlan(path).segments] : []);
export const getBySegments = <T = unknown>(obj: unknown, segments: string[]): T | undefined => getJsonBySegments<T>(obj, segments);
export const setByPath = (obj: unknown, path: string, value: unknown): void => { writeJsonPath(obj, path, value); };
export const deleteByPath = (obj: unknown, path: string): void => { deleteJsonPath(obj, path); };
// Queries are lenient: an unparseable/forbidden path means "not present" (writes still throw).
export const hasPath = (obj: unknown, path: string): boolean => {
  try { return hasJsonPath(obj, path); } catch { return false; }
};

// JSON-like deep clone with structuredClone fallback
export function cloneJson<T>(value: T): T {
  return cloneJsonData(value);
}

export function setPathCacheLimit(limit: number): void {
  // Bounds the engine-wide path plan cache (one cache shared by every host project).
  setJsonPlanCacheLimit(limit);
}

const NEEDS_QUOTES = /[\[\]\.\s]/;

/** Builds a safe path from segments: quotes when needed and uses bracket notation for array indexes. */
export function buildPath(...segments: Array<string | number>): string {
  let out = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const s = String(seg);
    if (typeof seg === 'number' || (isNumericSegment(s) && i > 0)) {
      out += `[${Number(seg)}]`;
    } else if (NEEDS_QUOTES.test(s) || s.length === 0 || isNumericSegment(s)) {
      out += `["${s.replace(/["\\]/g, (r) => `\\${r}`)}"]`;
    } else {
      out += i === 0 ? s : `.${s}`;
    }
  }
  return out;
}
