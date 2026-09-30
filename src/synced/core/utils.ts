import {
  cloneJsonData,
  createJsonPathPlan,
  deleteJsonPath,
  getJsonBySegments,
  hasJsonPath,
  setJsonPlanCacheLimit,
  writeJsonPath,
} from './data-engine';

import { isNumericSegment as isNumeric, isObject, isRecordObject } from '../internal/guards';

export { isObject, isRecordObject };

// splitPath shares the engine's bounded plan cache, so path parsing behaves (and
// performs) identically in every host project; returns a fresh, mutable copy.
export const splitPath = (path: string): string[] => (path ? [...createJsonPathPlan(path).segments] : []);
export const getBySegments = <T = unknown>(obj: unknown, segments: string[]): T | undefined => getJsonBySegments<T>(obj, segments);
export const setByPath = (obj: unknown, path: string, value: unknown): void => { writeJsonPath(obj, path, value); };
export const deleteByPath = (obj: unknown, path: string): void => { deleteJsonPath(obj, path); };
// Queries are lenient: an unparseable/forbidden path means "not present" (writes still throw).
export const hasPath = (obj: unknown, path: string): boolean => {
  try { return hasJsonPath(obj, path); } catch { return false; }
};

export type TraverseFrame<TNode = unknown, TParent = unknown, TKey extends string | number = string | number> = {
  data: TNode;
  path?: string[];
  depth: number;
  parent?: TParent;
  parentKey?: TKey;
};

export interface ScanJsonOptions {
  maxDepth: number;
  includeArrays: boolean;
  includeObjects: boolean;
  buildMeta: boolean;
  returnPaths: boolean;
}

/**
 * Allocation-light DFS for match collection. Stack state is stored in parallel
 * arrays and result nodes are created only for matches, unlike the generator
 * contract which must allocate a frame for every visited value.
 */
export function scanJsonMatches(
  data: unknown,
  options: ScanJsonOptions,
  predicate: (node: unknown) => boolean,
  onMatch: (node: TraverseFrame) => boolean | void
): { nodesVisited: number; maxDepth: number; stopped: boolean } {
  if (!options.buildMeta && !options.returnPaths) {
    const nodes: unknown[] = [data];
    const depths: number[] = [0];
    let nodesVisited = 0;
    let observedMaxDepth = 0;
    while (nodes.length > 0) {
      const node = nodes.pop();
      const depth = depths.pop()!;
      nodesVisited++;
      if (depth > observedMaxDepth) observedMaxDepth = depth;
      if (predicate(node) && onMatch({ data: node, depth }) === false) {
        return { nodesVisited, maxDepth: observedMaxDepth, stopped: true };
      }
      if (depth >= options.maxDepth) continue;
      const nextDepth = depth + 1;
      if (Array.isArray(node) && options.includeArrays) {
        for (let index = node.length - 1; index >= 0; index--) {
          nodes.push(node[index]);
          depths.push(nextDepth);
        }
      } else if (isObject(node) && options.includeObjects) {
        const keys = Object.keys(node);
        for (let index = keys.length - 1; index >= 0; index--) {
          nodes.push(node[keys[index]!]);
          depths.push(nextDepth);
        }
      }
    }
    return { nodesVisited, maxDepth: observedMaxDepth, stopped: false };
  }

  const nodes: unknown[] = [data];
  const depths: number[] = [0];
  const parents: unknown[] = [undefined];
  const parentKeys: Array<string | number | undefined> = [undefined];
  const segments: Array<string | null> = [null];
  const pathBuffer: string[] = [];
  let nodesVisited = 0;
  let observedMaxDepth = 0;

  while (nodes.length > 0) {
    const node = nodes.pop();
    const depth = depths.pop()!;
    const parent = parents.pop();
    const parentKey = parentKeys.pop();
    const segment = segments.pop()!;
    nodesVisited++;
    if (depth > observedMaxDepth) observedMaxDepth = depth;

    if (options.returnPaths) {
      if (segment === null) {
        pathBuffer.length = 0;
      } else {
        pathBuffer[depth - 1] = segment;
        pathBuffer.length = depth;
      }
    }

    if (predicate(node)) {
      const result: TraverseFrame = {
        data: node,
        path: options.returnPaths ? pathBuffer.slice(0, depth) : undefined,
        depth,
        parent: options.buildMeta ? parent : undefined,
        parentKey: options.buildMeta ? parentKey : undefined,
      };
      if (onMatch(result) === false) {
        return { nodesVisited, maxDepth: observedMaxDepth, stopped: true };
      }
    }

    if (depth >= options.maxDepth) continue;
    const nextDepth = depth + 1;
    if (Array.isArray(node) && options.includeArrays) {
      for (let index = node.length - 1; index >= 0; index--) {
        nodes.push(node[index]);
        depths.push(nextDepth);
        parents.push(node);
        parentKeys.push(index);
        segments.push(String(index));
      }
    } else if (isObject(node) && options.includeObjects) {
      const keys = Object.keys(node);
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index]!;
        nodes.push(node[key]);
        depths.push(nextDepth);
        parents.push(node);
        parentKeys.push(key);
        segments.push(key);
      }
    }
  }

  return { nodesVisited, maxDepth: observedMaxDepth, stopped: false };
}

export function* dfsIterator<TNode = unknown, TParent = unknown, TKey extends string | number = string | number>(
  data: TNode,
  options: { maxDepth: number; includeArrays: boolean; includeObjects: boolean; buildMeta: boolean; returnPaths: boolean; shouldDescend?: (frame: TraverseFrame<TNode, TParent, TKey>) => boolean }
): Generator<TraverseFrame<TNode, TParent, TKey>> {
  const { maxDepth, includeArrays, includeObjects, buildMeta, returnPaths, shouldDescend } = options;
  // Shared path buffer: O(1) index assignment per push instead of O(depth) spread-copy.
  // At yield time, slice(0, depth) produces a fresh array the caller owns — same contract
  // as before, but the per-push allocation ([...(path), segment]) is eliminated.
  // For a 10k-node tree at depth 10 this removes ~100k element copies from the push side.
  const pathBuffer: string[] = [];
  const stack: Array<{ node: TNode; segment: string | null; depth: number; parent?: TParent; parentKey?: TKey }> = [
    { node: data, segment: null, depth: 0 }
  ];
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.depth > maxDepth) continue;
    const { node, segment, depth, parent, parentKey } = frame;
    if (returnPaths) {
      if (segment !== null) {
        pathBuffer[depth - 1] = segment;
        pathBuffer.length = depth; // truncate stale deeper segments from prior branches
      } else {
        pathBuffer.length = 0; // root
      }
    }
    const path = returnPaths ? pathBuffer.slice(0, depth) : undefined;
    const cur: TraverseFrame<TNode, TParent, TKey> = { data: node, path, depth, parent, parentKey } as TraverseFrame<TNode, TParent, TKey>;
    yield cur;
    if (shouldDescend && shouldDescend(cur) === false) continue;
    const nextDepth = depth + 1;
    if (Array.isArray(node) && includeArrays) {
      const arr = node as unknown[];
      for (let i = arr.length - 1; i >= 0; i--) {
        stack.push({
          node: arr[i] as TNode,
          segment: String(i),
          depth: nextDepth,
          parent: buildMeta ? (node as unknown as TParent) : undefined,
          parentKey: buildMeta ? (i as unknown as TKey) : undefined,
        });
      }
    } else if (isObject(node) && includeObjects) {
      const obj = node as Record<string, unknown>;
      const keys = Object.keys(obj);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        stack.push({
          node: obj[k] as TNode,
          segment: k,
          depth: nextDepth,
          parent: buildMeta ? (node as unknown as TParent) : undefined,
          parentKey: buildMeta ? (k as unknown as TKey) : undefined,
        });
      }
    }
  }
}

export interface ResolvedTargetPath {
  targetNode: unknown;
  targetParent: unknown;
  targetKey?: string | number;
}

/**
 * Walk `path` from `root` and return the node, its parent and the final key.
 * With `create=true` missing object segments are created ({} or [] when the
 * next segment is numeric) and a missing array index stops the walk (so the
 * parent array + index are returned for relative inserts). With `create=false`
 * nothing is attached: missing segments resolve to a simulated empty node so
 * callers can validate the target shape without mutating the tree.
 */
export function resolveTargetPath(root: unknown, path: string, create: boolean): ResolvedTargetPath {
  const parts = splitPath(path);
  let parent: unknown = null;
  let node: unknown = root;
  let key: string | number | undefined = undefined;
  const len = parts.length;
  for (let i = 0; i < len; i++) {
    const part = parts[i];
    parent = node;
    key = isNumeric(part) ? Number(part) : part;
    if (typeof key === 'number') {
      if (!Array.isArray(parent)) return { targetNode: undefined, targetParent: parent, targetKey: key };
      const exists = key in parent;
      node = (parent as unknown[])[key];
      if (create && !exists) break;
      continue;
    }
    if (!isObject(parent)) return { targetNode: undefined, targetParent: parent, targetKey: key };
    const record = parent as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      node = record[key];
      continue;
    }
    const next = i + 1 < len && isNumeric(parts[i + 1]) ? [] : {};
    if (create) record[key] = next;
    node = next;
  }
  return { targetNode: node, targetParent: parent, targetKey: key };
}

export function resolveTargetWithPathCreation(root: unknown, path: string): ResolvedTargetPath {
  return resolveTargetPath(root, path, true);
}

export type DeepMergeOptions = {
  arrayStrategy?: 'replace' | 'concat' | 'merge-by-key';
  arrayKey?: string | ((x: unknown) => string | number);
};

function mergeArrays(aArr: unknown[] | undefined, bArr: unknown[] | undefined, opts: DeepMergeOptions): unknown[] {
  const a = Array.isArray(aArr) ? aArr : [];
  const b = Array.isArray(bArr) ? bArr : [];
  const strat = opts.arrayStrategy ?? 'replace';
  if (strat === 'replace') return bArr !== undefined ? b : a;
  if (strat === 'concat') return [...a, ...b];
  // merge-by-key
  const keyer = opts.arrayKey ?? 'id';
  const getKey = (x: unknown): unknown => typeof keyer === 'function'
    ? keyer(x)
    : (x as Record<string, unknown>)?.[keyer as keyof typeof x];
  const isKey = (value: unknown): value is string | number =>
    typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
  const countKeys = (items: unknown[]): Map<string | number, number> => {
    const counts = new Map<string | number, number>();
    for (const item of items) {
      const key = getKey(item);
      if (isKey(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const aCounts = countKeys(a);
  const bCounts = countKeys(b);
  const out = [...a];
  const uniqueAIndex = new Map<string | number, number>();
  for (let i = 0; i < a.length; i++) {
    const key = getKey(a[i]);
    if (isKey(key) && aCounts.get(key) === 1) uniqueAIndex.set(key, i);
  }
  for (const item of b) {
    const key = getKey(item);
    // Missing or duplicate keys are ambiguous. Preserve every value instead of
    // collapsing them into a single Map entry and silently dropping data.
    if (!isKey(key) || (aCounts.get(key) ?? 0) > 1 || (bCounts.get(key) ?? 0) > 1) {
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
  if (Array.isArray(a) || Array.isArray(b)) {
    return mergeArrays(Array.isArray(a) ? (a as unknown[]) : undefined, Array.isArray(b) ? (b as unknown[]) : undefined, opts);
  }
  if (isObject(a) && isObject(b)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const k of Object.keys(b as Record<string, unknown>)) {
      const av = (a as Record<string, unknown>)[k];
      const bv = (b as Record<string, unknown>)[k];
      if (isObject(av) && isObject(bv) && !Array.isArray(av) && !Array.isArray(bv)) {
        out[k] = deepMerge(av, bv, opts);
      } else if (Array.isArray(av) || Array.isArray(bv)) {
        out[k] = deepMerge(av, bv, opts);
      } else {
        out[k] = bv;
      }
    }
    return out;
  }
  return b !== undefined ? b : a;
}

// JSON-like deep clone with structuredClone fallback
export function cloneJson<T>(value: T): T {
  return cloneJsonData(value);
}

export function setPathCacheLimit(limit: number): void {
  // Bounds the engine-wide path plan cache (one cache shared by every host project).
  setJsonPlanCacheLimit(limit);
}

// Build a safe path from segments, quoting when needed and using bracket notation for array indexes
export function buildPath(...segments: Array<string | number>): string {
  const out: string[] = [];
  const len = segments.length;
  for (let i = 0; i < len; i++) {
    const seg = segments[i];
    if (typeof seg === 'number' || (isNumeric(String(seg)) && out.length > 0)) {
      out.push(`[${Number(seg)}]`);
      continue;
    }
    const s = String(seg);
    const needsQuote = /[\[\]\.\s]/.test(s);
    if (i === 0 && !needsQuote && s.length > 0 && !isNumeric(s)) {
      out.push(s);
    } else if (needsQuote || s.length === 0 || isNumeric(s)) {
      const escaped = s.replace(/["\\]/g, r => `\\${r}`);
      out.push(`["${escaped}"]`);
    } else {
      out.push(`.${s}`);
    }
  }
  return out.join('');
}

// Deep search path parsing - rozpoznaje @ jako operator deep array search
export interface DeepSearchPath {
  isDeep: boolean;
  arrayKey?: string;      // Klucz tablicy dla deep search (np. "fields", "layout")
  searchSegments: string[]; // Segmenty ścieżki po @ (np. ["id"] dla "fields@id")
}

export function parseDeepSearchPath(path: string): DeepSearchPath {
  if (!path) {
    return { isDeep: false, searchSegments: [] };
  }

  // Sprawdź czy path zawiera @
  const atIndex = path.indexOf('@');

  if (atIndex === -1) {
    // Brak @ - zwykła ścieżka
    return { isDeep: false, searchSegments: splitPath(path) };
  }

  if (atIndex === 0) {
    // @ na początku (np. "@id") - deep search w bieżącej tablicy
    const searchPath = path.substring(1);
    return {
      isDeep: true,
      arrayKey: undefined,  // Bieżąca tablica
      searchSegments: splitPath(searchPath)
    };
  }

  // @ w środku (np. "fields@id") - deep search w określonej tablicy
  const arrayKey = path.substring(0, atIndex);
  const searchPath = path.substring(atIndex + 1);

  return {
    isDeep: true,
    arrayKey,
    searchSegments: splitPath(searchPath)
  };
}

// Deep array matching - rekurencyjne przeszukiwanie tablicy
export function deepArrayMatch(
  node: unknown,
  arrayKey: string | undefined,
  searchSegments: string[],
  opFn: (a: unknown, b: unknown) => boolean,
  value: unknown,
  maxDepth: number = Number.POSITIVE_INFINITY
): boolean {
  for (const _ of deepArrayIterator(node, arrayKey, searchSegments, opFn, value, [], 0, maxDepth)) {
    return true;
  };
  return false;
}

// Deep array iterator - yield all matching elements from nested arrays
export function* deepArrayIterator(
  node: unknown,
  arrayKey: string | undefined,
  searchSegments: string[],
  opFn: (a: unknown, b: unknown) => boolean,
  value: unknown,
  path: string[] = [],
  depth: number = 0,
  maxDepth: number = Number.POSITIVE_INFINITY
): Generator<{ data: unknown; path?: string[]; depth: number; parent?: unknown; parentKey?: string | number }> {
  if (!arrayKey) {
    // @id - yield node itself if matches
    const nodeValue = getBySegments(node, searchSegments);
    if (opFn(nodeValue, value)) {
      yield { data: node, path, depth };
    }
    return;
  }

  const arrayKeySegments = splitPath(arrayKey);
  // fields@id - iterate through array and nested arrays
  const targetArray = getBySegments(node, arrayKeySegments);

  if (!Array.isArray(targetArray)) {
    return;
  }

  type ArrayFrame = {
    arr: unknown[];
    currentPath: string[];
    currentDepth: number;
    parent: unknown;
    nextIndex: number;
    ancestorArrays: unknown[][];
  };

  const stack: ArrayFrame[] = [{
    arr: targetArray,
    currentPath: [...path, ...arrayKeySegments],
    currentDepth: depth,
    parent: node,
    nextIndex: 0,
    ancestorArrays: [targetArray],
  }];

  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.nextIndex >= frame.arr.length) {
      stack.pop();
      continue;
    }

    const i = frame.nextIndex++;
    const item = frame.arr[i];
    const itemPath = [...frame.currentPath, String(i)];
    const itemValue = getBySegments(item, searchSegments);

    if (opFn(itemValue, value)) {
      yield { data: item, path: itemPath, depth: frame.currentDepth, parent: frame.arr, parentKey: i };
    }

    if (frame.currentDepth >= maxDepth || !isObject(item)) {
      continue;
    }

    const nestedArray = getBySegments(item, arrayKeySegments);
    if (!Array.isArray(nestedArray) || frame.ancestorArrays.includes(nestedArray)) {
      continue;
    }

    stack.push({
      arr: nestedArray,
      currentPath: [...itemPath, ...arrayKeySegments],
      currentDepth: frame.currentDepth + 1,
      parent: item,
      nextIndex: 0,
      ancestorArrays: [...frame.ancestorArrays, nestedArray],
    });
  }
}
