/** Structural deep merge with pluggable array strategies (`replace`, `concat`, `merge-by-key`). */
import { isObject } from './guards';

export type DeepMergeOptions = {
  arrayStrategy?: 'replace' | 'concat' | 'merge-by-key';
  arrayKey?: string | ((x: unknown) => string | number);
};

type ArrayMergeStrategy = NonNullable<DeepMergeOptions['arrayStrategy']>;
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
    // Missing or duplicate keys are ambiguous. Preserve every value instead of
    // collapsing them into a single Map entry and silently dropping data.
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

const ARRAY_MERGERS: Record<ArrayMergeStrategy, ArrayMerger> = {
  // A missing `b` keeps `a`; a present (even empty) `b` wins.
  replace: (a, b, _opts, bDefined) => (bDefined ? b : a),
  concat: (a, b) => [...a, ...b],
  'merge-by-key': mergeByKey,
};

function mergeArrays(aArr: unknown[] | undefined, bArr: unknown[] | undefined, opts: DeepMergeOptions): unknown[] {
  // Unknown strategy names (untyped callers) behave like merge-by-key, as before.
  const merge = ARRAY_MERGERS[opts.arrayStrategy ?? 'replace'] ?? mergeByKey;
  return merge(aArr ?? [], bArr ?? [], opts, bArr !== undefined);
}

/**
 * Deep merge overloads for better DX without breaking runtime behavior.
 * - Arrays: returns unknown[] (strategy affects shape).
 * - Objects: returns intersection-like object (A & B).
 * - Fallback: unknown (keeps compatibility).
 */
export function deepMerge<A extends unknown[], B extends unknown[]>(
  a: A,
  b: B,
  opts?: DeepMergeOptions
): unknown[];
export function deepMerge<A extends Record<string, unknown>, B extends Record<string, unknown>>(
  a: A,
  b: B,
  opts?: DeepMergeOptions
): A & B;
// Fallback overload to preserve dynamic unknown usage sites
export function deepMerge(a: unknown, b: unknown, opts?: DeepMergeOptions): unknown;
export function deepMerge(a: unknown, b: unknown, opts: DeepMergeOptions = {}): unknown {
  const aIsArray = Array.isArray(a);
  if (aIsArray || Array.isArray(b)) {
    return mergeArrays(aIsArray ? a : undefined, Array.isArray(b) ? b : undefined, opts);
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
