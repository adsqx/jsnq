import { buildPlan, splitJsonPath } from './parse';
import type { JsonPathPlan, JsonPlanCacheStats } from './types';

let planCacheMax = 5000;
// Generational eviction: `current` fills up, then becomes `previous` in an O(1) swap.
// The previous strategy deleted the oldest key via `planCache.keys().next().value` on every
// insert, which allocates an iterator and walks a tombstoned V8 OrderedHashMap. Measured on
// a 90%-repeat / 10%-new path mix (200k ops) that cost 181ms, and 1694ms on all-unique
// paths — far more than simply rebuilding the plan. Generational eviction removes that
// cliff while keeping about one full generation of plans resident.
let planCache = new Map<string, JsonPathPlan>();
let planCachePrev = new Map<string, JsonPathPlan>();
const planCacheMetrics = { hits: 0, misses: 0, writes: 0, evictions: 0 };

function lookupPlan(path: string): JsonPathPlan | undefined {
  const hit = planCache.get(path);
  if (hit !== undefined) return hit;
  const stale = planCachePrev.get(path);
  if (stale !== undefined) planCache.set(path, stale); // promote into the live generation
  return stale;
}

function cachePlan(path: string, plan: JsonPathPlan): JsonPathPlan {
  planCache.set(path, plan);
  planCacheMetrics.writes++;
  if (planCache.size > planCacheMax) {
    planCacheMetrics.evictions += planCachePrev.size;
    planCachePrev = planCache;
    planCache = new Map();
  }
  return plan;
}

/** Bound the compiled path-plan cache (FIFO eviction); floor of 16 entries. */
export function setJsonPlanCacheLimit(limit: number): void {
  planCacheMax = Math.max(16, Math.floor(limit));
  if (planCache.size > planCacheMax) {
    planCacheMetrics.evictions += planCachePrev.size + planCache.size;
    planCachePrev = new Map();
    planCache = new Map();
  }
}

export function getJsonPlanCacheStats(): JsonPlanCacheStats {
  const { hits, misses, writes, evictions } = planCacheMetrics;
  const total = hits + misses;
  return {
    size: planCache.size + planCachePrev.size,
    limit: planCacheMax,
    hits,
    misses,
    writes,
    evictions,
    hitRate: total > 0 ? hits / total : 0,
  };
}

export function clearJsonPlanCache(): void {
  planCache.clear();
  planCachePrev.clear();
  planCacheMetrics.hits = 0;
  planCacheMetrics.misses = 0;
  planCacheMetrics.writes = 0;
  planCacheMetrics.evictions = 0;
}

/** Cached, shared (unfrozen) plan for a path string. Forbidden segments throw here. */
export function createJsonPathPlan(path: string): JsonPathPlan {
  const normalized = path ?? '';
  const cached = lookupPlan(normalized);
  if (cached) {
    planCacheMetrics.hits++;
    return cached;
  }
  planCacheMetrics.misses++;
  return cachePlan(normalized, buildPlan(normalized, splitJsonPath(normalized)));
}

/** Accepts either a path string or an already compiled plan. */
export function toPlan(pathOrPlan: string | JsonPathPlan): JsonPathPlan {
  return typeof pathOrPlan === 'string' ? createJsonPathPlan(pathOrPlan) : pathOrPlan;
}

export function getJsonParentSegments(pathOrPlan: string | JsonPathPlan): string[] {
  return toPlan(pathOrPlan).parentSegments;
}
