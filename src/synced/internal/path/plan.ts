/** Path plans: string -> segments parsing, plan construction and the bounded plan cache. Type-level exports are public via core/data-engine. */
import { assertSafeSegments, isNumericSegment } from '../guards';

export type JsonDataPathMode = 'exact' | 'branch';

export interface JsonPathPlan {
  path: string;
  segments: string[];
  parentSegments: string[];
  key: string | null;
  nextIsIndex: boolean[];
}

export interface JsonResolvedParent {
  parent: any;
  key: string | null;
  segments: string[];
}

export interface JsonPlanCacheStats {
  size: number;
  limit: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  hitRate: number;
}

/** Reads a `[...]` group starting just after the `[`; pushes its segment and returns the next index. */
function readBracket(path: string, start: number, out: string[]): number {
  const n = path.length;
  let i = start;
  const quote = path[i];
  if (quote === '"' || quote === "'") {
    i++;
    let quoted = '';
    while (i < n) {
      const ch = path[i]!;
      if (ch === '\\' && i + 1 < n) {
        quoted += path[i + 1];
        i += 2;
      } else if (ch === quote) {
        i++;
        break;
      } else {
        quoted += ch;
        i++;
      }
    }
    if (path[i] === ']') i++;
    out.push(quoted); // a quoted segment may be empty
    return i;
  }
  let end = path.indexOf(']', i);
  if (end < 0) end = n;
  if (end > i) out.push(path.slice(i, end));
  return end < n ? end + 1 : end;
}

/** Full scanner: handles `\` escapes, `[idx]` and `["quoted"]` groups. Empty dotted segments are dropped. */
function scanPath(path: string): string[] {
  const out: string[] = [];
  const n = path.length;
  let token = '';
  let i = 0;
  while (i < n) {
    const ch = path[i]!;
    if (ch === '\\') {
      if (i + 1 < n) token += path[i + 1];
      i += 2;
    } else if (ch === '.' || ch === '[') {
      if (token) out.push(token);
      token = '';
      i++;
      if (ch === '[') {
        if (i >= n) break;
        i = readBracket(path, i, out);
      }
    } else {
      token += ch;
      i++;
    }
  }
  if (token) out.push(token);
  return out;
}

export function splitJsonPath(path: string): string[] {
  // Non-string input (untyped callers) has always produced an empty split rather than a throw.
  if (!path || typeof path !== 'string') return [];
  let out: string[];
  if (path.indexOf('\\') < 0 && path.indexOf('[') < 0) {
    // Plain dotted path: no escapes or brackets, so a native split is exact.
    out = path.split('.');
    if (out.indexOf('') >= 0) out = out.filter(Boolean);
  } else {
    out = scanPath(path);
  }
  assertSafeSegments(out, path);
  return out;
}

/** The single place a plan literal is built (fixed key order keeps plans monomorphic). */
function buildPlan(path: string, segments: string[]): JsonPathPlan {
  const last = segments.length - 1;
  const nextIsIndex: boolean[] = [];
  for (let i = 1; i <= last; i++) nextIsIndex.push(isNumericSegment(segments[i]));
  return { path, segments, parentSegments: segments.slice(0, -1), key: last >= 0 ? segments[last]! : null, nextIsIndex };
}

/** Uncached plan from raw segments (used by fast paths that already hold split segments). */
export function createJsonPathPlanFromSegments(segments: readonly string[]): JsonPathPlan {
  const safeSegments = Array.from(segments, String);
  const path = safeSegments.join('.');
  assertSafeSegments(safeSegments, path);
  return buildPlan(path, safeSegments);
}

let planCacheMax = 5000;
// Generational eviction: `current` fills up, then becomes `previous` in an O(1) swap. Deleting the
// oldest key via `keys().next().value` on every insert cost 181ms (90% repeat mix, 200k ops) and
// 1694ms on all-unique paths, far more than rebuilding the plan; this keeps ~one generation resident.
let planCache = new Map<string, JsonPathPlan>();
let planCachePrev = new Map<string, JsonPathPlan>();
const metrics = { hits: 0, misses: 0, writes: 0, evictions: 0 };

/** Bound the compiled path-plan cache (generational eviction); floor of 16 entries. */
export function setJsonPlanCacheLimit(limit: number): void {
  planCacheMax = Math.max(16, Math.floor(limit));
  if (planCache.size > planCacheMax) {
    metrics.evictions += planCachePrev.size + planCache.size;
    planCachePrev = new Map();
    planCache = new Map();
  }
}

export function getJsonPlanCacheStats(): JsonPlanCacheStats {
  const { hits, misses, writes, evictions } = metrics;
  const total = hits + misses;
  return { size: planCache.size + planCachePrev.size, limit: planCacheMax, hits, misses, writes, evictions, hitRate: total > 0 ? hits / total : 0 };
}

export function clearJsonPlanCache(): void {
  planCache.clear();
  planCachePrev.clear();
  Object.assign(metrics, { hits: 0, misses: 0, writes: 0, evictions: 0 });
}

/** Cached, shared (unfrozen) plan for a path string. Forbidden segments throw here. */
export function createJsonPathPlan(path: string): JsonPathPlan {
  const normalized = path ?? '';
  const hit = planCache.get(normalized);
  if (hit !== undefined) {
    metrics.hits++;
    return hit;
  }
  const stale = planCachePrev.get(normalized);
  if (stale !== undefined) {
    planCache.set(normalized, stale); // promote into the live generation
    metrics.hits++;
    return stale;
  }
  metrics.misses++;
  const plan = buildPlan(normalized, splitJsonPath(normalized));
  planCache.set(normalized, plan);
  metrics.writes++;
  if (planCache.size > planCacheMax) {
    metrics.evictions += planCachePrev.size;
    planCachePrev = planCache;
    planCache = new Map();
  }
  return plan;
}

/** Accepts either a path string or an already compiled plan. */
export function toPlan(pathOrPlan: string | JsonPathPlan): JsonPathPlan {
  return typeof pathOrPlan === 'string' ? createJsonPathPlan(pathOrPlan) : pathOrPlan;
}

export function getJsonParentSegments(pathOrPlan: string | JsonPathPlan): string[] {
  return toPlan(pathOrPlan).parentSegments;
}
