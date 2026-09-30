/**
 * Pure tree helpers: string-path facade over the shared plan cache, move/copy/insert target
 * resolution and structural deep merge. Re-exported by core/utils.
 */
import { isNumericSegment, isObject } from './guards';
import {
  cloneJsonData, createJsonPathPlan, deleteJsonPath, getJsonBySegments, hasJsonPath, setJsonPlanCacheLimit, writeJsonPath,
} from '../core/data-engine';

// ---- string-path facade (one bounded plan cache shared by every host project) ----

/** Parses `path` into a fresh, mutable segment array (`''` -> `[]`). */
export const splitPath = (path: string): string[] => (path ? [...createJsonPathPlan(path).segments] : []);
export const getBySegments = <T = unknown>(obj: unknown, segments: string[]): T | undefined => getJsonBySegments<T>(obj, segments);
export const setByPath = (obj: unknown, path: string, value: unknown): void => { writeJsonPath(obj, path, value); };
export const deleteByPath = (obj: unknown, path: string): void => { deleteJsonPath(obj, path); };
// Queries are lenient: an unparseable/forbidden path means "not present" (writes still throw).
export const hasPath = (obj: unknown, path: string): boolean => {
  try { return hasJsonPath(obj, path); } catch { return false; }
};

/** JSON-like deep clone with structuredClone fallback. */
export function cloneJson<T>(value: T): T {
  return cloneJsonData(value);
}

/** Bounds the engine-wide path plan cache. */
export function setPathCacheLimit(limit: number): void {
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

// ---- target resolution ----

export interface ResolvedTargetPath {
  targetNode: unknown;
  targetParent: unknown;
  targetKey?: string | number;
}

/**
 * Walk `path` from `root` and return the node, its parent and the final key. With `create=true`
 * missing object segments are created ({} or [] when the next segment is numeric) and a missing
 * array index stops the walk (parent array + index are returned for relative inserts). With
 * `create=false` nothing is attached: missing segments resolve to a simulated empty node so
 * callers can validate the target shape without mutating the tree.
 */
export function resolveTargetPath(root: unknown, path: string, create: boolean): ResolvedTargetPath {
  const parts = splitPath(path);
  let parent: unknown = null;
  let node: unknown = root;
  let key: string | number | undefined;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    parent = node;
    if (isNumericSegment(part)) {
      key = Number(part);
      // Numeric segments address array slots only.
      if (!Array.isArray(parent)) return { targetNode: undefined, targetParent: parent, targetKey: key };
      const exists = key in parent;
      node = parent[key];
      if (create && !exists) break;
      continue;
    }
    key = part;
    if (!isObject(parent)) return { targetNode: undefined, targetParent: parent, targetKey: key };
    if (Object.prototype.hasOwnProperty.call(parent, key)) {
      node = parent[key];
      continue;
    }
    const next = isNumericSegment(parts[i + 1]) ? [] : {};
    if (create) parent[key] = next;
    node = next;
  }
  return { targetNode: node, targetParent: parent, targetKey: key };
}

export function resolveTargetWithPathCreation(root: unknown, path: string): ResolvedTargetPath {
  return resolveTargetPath(root, path, true);
}

// ---- deep merge ----

export type DeepMergeOptions = {
  arrayStrategy?: 'replace' | 'concat' | 'merge-by-key';
  arrayKey?: string | ((x: unknown) => string | number);
};

type MergeKey = string | number;

const isMergeKey = (value: unknown): value is MergeKey =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** Occurrence count per usable key; items without a usable key are ignored. */
function countKeys(items: unknown[], keyOf: (x: unknown) => unknown): Map<MergeKey, number> {
  const counts = new Map<MergeKey, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (isMergeKey(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function mergeByKey(a: unknown[], b: unknown[], opts: DeepMergeOptions): unknown[] {
  const keyer = opts.arrayKey ?? 'id';
  const keyOf = (x: unknown): unknown => (typeof keyer === 'function' ? keyer(x) : (x as Record<string, unknown> | null | undefined)?.[keyer]);
  const aCounts = countKeys(a, keyOf);
  const bCounts = countKeys(b, keyOf);
  const out = [...a];
  const uniqueAIndex = new Map<MergeKey, number>();
  for (let i = 0; i < a.length; i++) {
    const key = keyOf(a[i]);
    if (isMergeKey(key) && aCounts.get(key) === 1) uniqueAIndex.set(key, i);
  }
  for (const item of b) {
    const key = keyOf(item);
    // Missing or duplicate keys are ambiguous: keep every value instead of collapsing them into one Map entry.
    if (!isMergeKey(key) || (aCounts.get(key) ?? 0) > 1 || (bCounts.get(key) ?? 0) > 1) {
      out.push(item);
      continue;
    }
    const existingIndex = uniqueAIndex.get(key);
    if (existingIndex !== undefined) {
      out[existingIndex] = deepMerge(out[existingIndex], item, opts);
    } else {
      uniqueAIndex.set(key, out.length);
      out.push(item);
    }
  }
  return out;
}

type ArrayMerger = (a: unknown[], b: unknown[], opts: DeepMergeOptions, bDefined: boolean) => unknown[];

const ARRAY_MERGERS: Record<NonNullable<DeepMergeOptions['arrayStrategy']>, ArrayMerger> = {
  // A missing `b` keeps `a`; a present (even empty) `b` wins.
  replace: (a, b, _opts, bDefined) => (bDefined ? b : a),
  concat: (a, b) => [...a, ...b],
  'merge-by-key': mergeByKey,
};

/** Overloads: arrays -> unknown[] (strategy affects shape), objects -> A & B, anything else -> unknown. */
export function deepMerge<A extends unknown[], B extends unknown[]>(a: A, b: B, opts?: DeepMergeOptions): unknown[];
export function deepMerge<A extends Record<string, unknown>, B extends Record<string, unknown>>(a: A, b: B, opts?: DeepMergeOptions): A & B;
export function deepMerge(a: unknown, b: unknown, opts?: DeepMergeOptions): unknown;
export function deepMerge(a: unknown, b: unknown, opts: DeepMergeOptions = {}): unknown {
  const aIsArray = Array.isArray(a);
  if (aIsArray || Array.isArray(b)) {
    // Unknown strategy names (untyped callers) behave like merge-by-key.
    const merge = ARRAY_MERGERS[opts.arrayStrategy ?? 'replace'] ?? mergeByKey;
    return merge(aIsArray ? a : [], Array.isArray(b) ? b : [], opts, Array.isArray(b));
  }
  if (isObject(a) && isObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const k of Object.keys(b)) {
      const av = a[k];
      const bv = b[k];
      // Recurse into object/object pairs and any pair involving an array; everything else is replaced.
      out[k] = (isObject(av) && isObject(bv)) || Array.isArray(av) || Array.isArray(bv) ? deepMerge(av, bv, opts) : bv;
    }
    return out;
  }
  return b !== undefined ? b : a;
}
