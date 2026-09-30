import { toPlan } from './plan-cache';
import type { JsonDataPathMode, JsonMutationKind, JsonMutationResult, JsonMutationResultInit, JsonPathPlan } from './types';

/** Shared, frozen empty list: results reuse it instead of allocating per-result empty arrays. */
export const EMPTY_JSON_PATHS: string[] = Object.freeze([]) as unknown as string[];

/** Dotted prefixes of `segments`: `count` running joins (`a`, `a.b`, ...). */
function prefixPaths(segments: readonly string[], count: number): string[] {
  const paths: string[] = [];
  let prefix = '';
  for (let i = 0; i < count; i++) {
    prefix = i === 0 ? segments[0]! : `${prefix}.${segments[i]}`;
    paths.push(prefix);
  }
  return paths;
}

export function getJsonAffectedPaths(pathOrPlan: string | JsonPathPlan, mode: JsonDataPathMode = 'exact'): string[] {
  const plan = toPlan(pathOrPlan);
  if (plan.segments.length === 0) return [''];
  if (mode === 'exact') return [plan.path];
  return prefixPaths(plan.segments, plan.segments.length);
}

function getParentAffectedPaths(plan: JsonPathPlan): string[] {
  const n = plan.segments.length;
  return n === 0 ? EMPTY_JSON_PATHS : prefixPaths(plan.segments, n - 1);
}

function uniqueJsonPaths(paths: readonly (string | null | undefined)[]): string[] {
  if (paths.length === 0) return EMPTY_JSON_PATHS;
  if (paths.length === 1) return paths[0] == null ? EMPTY_JSON_PATHS : (paths as string[]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (path == null || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Mutation result with a stable hidden class. `parents` is computed lazily via a
 * shared prototype getter: per-instance Object.defineProperty accessors made every
 * exact-path write allocate closures and de-optimize V8 inline caches, which
 * dominated browser write profiles (createMutationResult + GC > 55% self time).
 */
class JsonMutationResultImpl implements JsonMutationResult {
  path: string;
  kind: JsonMutationKind;
  previous: unknown;
  next: unknown;
  existed: boolean;
  changed: string[];
  inserted: string[];
  deleted: string[];
  descendants: string[];
  branchReplaced: boolean;
  affectedPaths: string[];
  private _plan: JsonPathPlan;
  private _parents: string[] | null;

  constructor(
    plan: JsonPathPlan,
    kind: JsonMutationKind,
    previous: unknown,
    next: unknown,
    existed: boolean,
    changed: string[],
    inserted: string[],
    deleted: string[],
    descendants: string[],
    branchReplaced: boolean,
    affectedPaths: string[],
    parents: string[] | null
  ) {
    this.path = plan.path;
    this.kind = kind;
    this.previous = previous;
    this.next = next;
    this.existed = existed;
    this.changed = changed;
    this.inserted = inserted;
    this.deleted = deleted;
    this.descendants = descendants;
    this.branchReplaced = branchReplaced;
    this.affectedPaths = affectedPaths;
    this._plan = plan;
    this._parents = parents;
  }

  get parents(): string[] {
    return (this._parents ??= getParentAffectedPaths(this._plan));
  }

  set parents(value: string[]) {
    this._parents = value;
  }
}

/** Allocation-light result for the exact single-path set hot path (proxy writes). */
export function createExactSetResult(
  plan: JsonPathPlan,
  previous: unknown,
  next: unknown,
  existed: boolean,
  branchReplaced: boolean
): JsonMutationResult {
  const changed = [plan.path];
  return new JsonMutationResultImpl(
    plan, 'set', previous, next, existed,
    changed, existed ? EMPTY_JSON_PATHS : changed, EMPTY_JSON_PATHS, EMPTY_JSON_PATHS,
    branchReplaced, changed, null
  );
}

export function createMutationResult(init: JsonMutationResultInit): JsonMutationResult {
  const plan = toPlan(init.path);
  const changed = uniqueJsonPaths(init.changed ?? EMPTY_JSON_PATHS);
  const inserted = uniqueJsonPaths(init.inserted ?? EMPTY_JSON_PATHS);
  const deleted = uniqueJsonPaths(init.deleted ?? EMPTY_JSON_PATHS);
  const descendants = uniqueJsonPaths(init.descendants ?? EMPTY_JSON_PATHS);
  const affectedPaths = uniqueJsonPaths(init.affectedPaths ?? [
    ...(init.parents ?? getParentAffectedPaths(plan)),
    ...changed,
    ...inserted,
    ...deleted,
    ...descendants,
  ]);
  return new JsonMutationResultImpl(
    plan, init.kind, init.previous, init.next, init.existed ?? false,
    changed, inserted, deleted, descendants,
    init.branchReplaced ?? false, affectedPaths,
    init.parents ? uniqueJsonPaths(init.parents) : null
  );
}
