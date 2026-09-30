import type { Action, CompiledCriterion, SearchOptions } from './types';
import { criteriaMatch } from './match';
import { compileCriteriaPredicate } from './compiled-predicate';
import { compileFlatMutation } from './compiled-mutation';
import { applyValueAction, isValueAction, prepareActions } from './actions';
import { cloneJson, getBySegments, splitPath } from './utils';
import { createJsonPathPlanFromSegments } from './data-engine';
import { hasNestedCriterionCandidate } from './flat-array-fast-path';
import { createStats } from '../internal/run-options';

/**
 * Host-commit fast path for `store.mutate(where(...), update(...))`-style calls.
 *
 * The generic flow used by host stores is: deep-clone the whole branch, run the
 * pipeline on the clone, commit the clone. For the #1 real-world shape — a flat
 * array filtered by non-deep criteria and mutated only with value actions —
 * that clones thousands of untouched items for nothing. This module computes
 * the same result with copy-on-write: a new outer array, matched items deep-
 * cloned and mutated via the exact same `actions.ts` appliers the pipeline
 * uses, untouched items shared by reference.
 *
 * Identity contract: the returned array is OWNED by the caller's store commit.
 * Unmatched elements alias the input (like solid-pipeline-bridge always did),
 * so the input itself is never mutated, but the output must be treated as the
 * next store state, not as an independent deep snapshot.
 *
 * Guards mirror the pipeline's flat-array fast path (same nested-candidate
 * probe), so whenever DFS could match a nested node we return undefined and
 * the caller falls back to the full pipeline — semantics stay identical.
 */

export interface PipelineIntent {
  criteria: CompiledCriterion[];
  actions: Action[];
  /** True when any operator tried to set pipeline options (limit/immutable/...). */
  optionsTouched: boolean;
}

export interface FastMutationResult<TData = unknown> {
  value: TData;
  /** Number of value-action applications (matched items × actions). */
  mutations: number;
  /** Number of items that matched the criteria. */
  matched: number;
  /** Changed paths relative to the branch, or null for non-precise shapes. */
  affectedPaths: string[] | null;
}

export interface FastMutationOptions {
  /**
   * Keep exact changed paths for precise host wakeups. Disable when the caller
   * only commits the returned value; this avoids one result object per match.
   */
  collectAffectedPaths?: boolean;
}

/** Matches JsnqPipeline's constructor defaults — keep in sync with pipeline.ts. */
const FASTPATH_OPTIONS: Readonly<SearchOptions> = {
  maxDepth: 10,
  includeArrays: true,
  includeObjects: true,
  trackOperations: false, // host-commit fast path never inspects operation labels
};

/**
 * Minimal pipeline-shaped spy: operators are called with it during collection
 * so we learn the compiled criteria/actions without touching any data.
 */
class IntentCollector {
  criteria: CompiledCriterion[] = [];
  actions: Action[] = [];
  optionsTouched = false;

  with(next: { criteria?: CompiledCriterion[]; actions?: Action[]; options?: unknown }): IntentCollector {
    const out = new IntentCollector();
    out.criteria = next.criteria ?? this.criteria;
    out.actions = next.actions ?? this.actions;
    out.optionsTouched = this.optionsTouched || next.options !== undefined;
    return out;
  }
}

export function collectPipelineIntent(ops: ReadonlyArray<unknown>): PipelineIntent {
  let collector = new IntentCollector();
  if (ops && ops.length > 0) {
    try {
      for (const op of ops) {
        if (typeof op !== 'function') return { criteria: [], actions: [], optionsTouched: true };
        collector = (op as (p: IntentCollector) => IntentCollector)(collector);
      }
    } catch {
      return { criteria: [], actions: [], optionsTouched: true };
    }
  }
  return {
    criteria: Array.isArray(collector.criteria) ? collector.criteria : [],
    actions: Array.isArray(collector.actions) ? collector.actions : [],
    optionsTouched: collector.optionsTouched,
  };
}

/**
 * Affected leaf paths (relative to the branch) for the flat value-action shape, so a
 * host can wake exactly the changed leaves instead of the whole branch ("grained" wake).
 * Returns null whenever the shape is not the guarded flat value-action fast path (same
 * guards as tryFastPipelineMutation), in which case the caller must fall back to a normal
 * branch commit. Pure read: never mutates the input. Shared by every host (Solid bridge,
 * Angular proxy) so fine-grained mutate wake stays logically identical across engines.
 */
export function collectFlatValueActionPaths(currentValue: unknown, ops: ReadonlyArray<unknown>): string[] | null {
  if (!Array.isArray(currentValue)) return null;
  const intent = collectPipelineIntent(ops);
  if (intent.optionsTouched) return null;
  if (intent.criteria.length === 0 || intent.actions.length === 0) return null;
  if (intent.criteria.some((criterion) => criterion.isDeep)) return null;

  // Only concrete string-key value actions (no sugar patch objects, no structural ops).
  const keys = preciseActionKeys(intent.actions);
  if (!keys) return null;
  // If a nested descendant could also match, the flat scan would diverge from DFS — bail.
  if (hasNestedCriterionCandidate(currentValue, intent.criteria, FASTPATH_OPTIONS)) return null;

  const strictCtx = { warnedUnknownOps: new Set<string>(), warnings: [] as string[] };
  const paths: string[] = [];
  for (let index = 0; index < currentValue.length; index++) {
    if (!criteriaMatch(intent.criteria, currentValue[index], FASTPATH_OPTIONS, strictCtx)) continue;
    appendAffectedPaths(paths, index, keys);
  }
  return paths;
}

function preciseActionKeys(actions: ReadonlyArray<Action>): string[] | null {
  const keys: string[] = [];
  for (const action of actions) {
    if (!isValueAction(action.type)) return null;
    const key = (action as { key?: unknown }).key;
    if (typeof key !== 'string' || key.length === 0 || splitPath(key).length !== 1) return null;
    keys.push(key);
  }
  return keys;
}

function cloneFlatItem(item: unknown): unknown {
  return Array.isArray(item)
    ? item.slice()
    : { ...(item as Record<string, unknown>) };
}

function appendAffectedPaths(paths: string[], index: number, keys: ReadonlyArray<string>): void {
  const itemPath = String(index);
  paths.push(itemPath);
  for (const key of keys) paths.push(`${itemPath}.${key}`);
}

type SugarPatch = Record<string, unknown>;

/** update({patch}) / replace({patch}) sugar: the patch object travels in `key`. */
function sugarPatchOf(action: Action): SugarPatch | null {
  if (action.type !== 'update' && action.type !== 'replace') return null;
  const key = (action as { key?: unknown }).key;
  if (key !== null && typeof key === 'object' && !Array.isArray(key)) return key as SugarPatch;
  return null;
}

function isFastPathAction(action: Action): boolean {
  if (sugarPatchOf(action)) return true;
  if (!isValueAction(action.type)) return false;
  const key = (action as { key?: unknown }).key;
  return typeof key === 'string' && key.length > 0;
}

function canFastPath(currentValue: unknown, intent: PipelineIntent): currentValue is unknown[] {
  if (intent.optionsTouched) return false;
  if (!Array.isArray(currentValue)) return false;
  if (intent.criteria.length === 0 || intent.actions.length === 0) return false;
  if (!intent.actions.every(isFastPathAction)) return false;
  if (intent.criteria.some((criterion) => criterion.isDeep)) return false;
  if (hasNestedCriterionCandidate(currentValue, intent.criteria, FASTPATH_OPTIONS)) return false;
  return true;
}

/**
 * Try the COW flat-array mutation. Returns undefined whenever the shape is not
 * the guarded hot path — callers must then run the full pipeline unchanged.
 */
export function tryFastPipelineMutation<TData = unknown>(
  currentValue: TData,
  ops: ReadonlyArray<unknown>,
  options: FastMutationOptions = {}
): FastMutationResult<TData> | undefined {
  const intent = collectPipelineIntent(ops);
  if (!canFastPath(currentValue, intent)) return undefined;

  const sugarPatches = intent.actions.map(sugarPatchOf);
  const standardActions = intent.actions.filter((_, i) => sugarPatches[i] === null);
  const prepared = prepareActions(standardActions);
  // Throwaway stats/ctx: applyValueAction records into them; hosts only need the value.
  const stats = createStats();
  const strictCtx = { warnedUnknownOps: new Set<string>(), warnings: stats.warnings };

  // Codegen fast path for the per-item match (null → interpreter; results identical).
  const pred = compileCriteriaPredicate(intent.criteria);

  const items = currentValue as unknown[];
  const preciseKeys = sugarPatches.some(Boolean) ? null : preciseActionKeys(intent.actions);
  const affectedPaths = options.collectAffectedPaths !== false && preciseKeys ? [] as string[] : null;
  let matched = 0;
  let mutations = 0;

  // Whole-loop codegen for static-value actions (no function values, no merge_update).
  // `next` is a shallow copy of the input array; compiled mutation replaces only
  // matched slots with clones, preserving the COW identity contract (unmatched
  // items alias the original input).
  const compiledMutation = compileFlatMutation<unknown>(intent.criteria, intent.actions);
  if (compiledMutation) {
    const next = items.slice();
    const results = compiledMutation(next, {
      immutable: true,
      dryRun: false,
      needPaths: affectedPaths !== null,
      strictPathsWarn: false,
      clone: preciseKeys === null ? cloneJson : cloneFlatItem,
      trackOperations: false,
      collectResults: affectedPaths !== null,
    }, stats);
    matched = stats.resultsFound;
    mutations = stats.replaces + stats.updates + stats.mergeUpdates + stats.deletedKeys;
    if (sugarPatches.some(Boolean)) {
      for (const node of results) {
        const clone = node.data;
        for (const patch of sugarPatches) {
          if (patch) {
            Object.assign(clone as SugarPatch, patch);
            mutations++;
          }
        }
      }
    }
    if (affectedPaths && preciseKeys) {
      for (const node of results) appendAffectedPaths(affectedPaths, Number(node.parentKey), preciseKeys);
    }
    return { value: (matched > 0 ? next : items) as TData, mutations, matched, affectedPaths };
  }

  // Interpreter fallback (function values, merge_update, etc.).
  const next: unknown[] = new Array(items.length);
  let anyMatched = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === null || typeof item !== 'object' || !(pred ? pred(item) : criteriaMatch(intent.criteria, item, FASTPATH_OPTIONS, strictCtx))) {
      next[i] = item;
      continue;
    }
    matched++;
    anyMatched = true;
    const clone = preciseKeys === null ? cloneJson(item) : cloneFlatItem(item);
    for (const patch of sugarPatches) {
      if (patch) {
        Object.assign(clone as SugarPatch, patch);
        mutations++;
      }
    }
    for (const action of prepared) {
      if (applyValueAction(clone, action, FASTPATH_OPTIONS, stats)) mutations++;
    }
    next[i] = clone;
    if (affectedPaths && preciseKeys) appendAffectedPaths(affectedPaths, i, preciseKeys);
  }

  return { value: (anyMatched ? next : items) as TData, mutations, matched, affectedPaths };
}

/* ========================================================================== */
/*            Single-action structural shortcuts (host fast paths)            */
/* ========================================================================== */
/*
 * These shortcuts used to live only in solid-pipeline-bridge.ts, so Angular
 * paid the full clone+pipeline cost for the same shapes. They are now part of
 * the shared library so every host commits the same COW results. Each guard
 * mirrors the pipeline's own semantics exactly (parity-tested):
 *   - insert at array root:    splice at clamped numeric key, else push
 *   - delete_key, no criteria: pipeline strips the key from EVERY object node
 *     at any depth, so we only fast-path arrays of flat items (primitive
 *     values only) where top-level stripping is provably identical
 *   - insert_to 'inside' an existing array: append via COW spine
 * Anything outside a guard returns undefined → caller runs the full pipeline.
 */

function isPlainFlatObject(item: unknown): item is Record<string, unknown> {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
  for (const key in item as Record<string, unknown>) {
    const value = (item as Record<string, unknown>)[key];
    if (value !== null && typeof value === 'object') return false;
  }
  return true;
}

/**
 * COW append for insert_to(position, data, 'inside') targeting an existing
 * array. Clones only the spine from root to the target array plus a shallow
 * copy of that array; untouched branches stay shared. Returns a NEW root, or
 * undefined when the shape is not the simple array-append form.
 */
export function applyInsertToInsideArrayCow(
  currentValue: unknown,
  position: string,
  data: unknown
): unknown | undefined {
  const segs = splitPath(position);
  if (segs.length === 0) return undefined;
  const target = getBySegments(currentValue, segs);
  if (!Array.isArray(target)) return undefined; // only the array 'inside' (push) case is fast-pathed
  const root: any = Array.isArray(currentValue)
    ? [...(currentValue as unknown[])]
    : { ...(currentValue as Record<string, unknown>) };
  let parent: any = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const child = parent[seg];
    if (child == null || typeof child !== 'object') return undefined; // unexpected shape → safe fallback
    parent[seg] = Array.isArray(child) ? [...child] : { ...child };
    parent = parent[seg];
  }
  parent[segs[segs.length - 1]!] = [...(target as unknown[]), data];
  return root;
}

/**
 * Try the criteria-less single-action shortcuts. The result is COW like
 * tryFastPipelineMutation (input never mutated, untouched branches shared).
 */
export function tryFastStructuralMutation<TData = unknown>(
  currentValue: TData,
  intent: PipelineIntent
): FastMutationResult<TData> | undefined {
  if (intent.optionsTouched) return undefined;
  if (intent.criteria.length !== 0 || intent.actions.length !== 1) return undefined;
  const action = intent.actions[0] as Action & {
    data?: unknown;
    value?: unknown;
    position?: unknown;
    mode?: unknown;
    key?: unknown;
  };
  if (!action) return undefined;

  // insert at an array root — mirrors pipeline's executeRootArrayInsertFastPath.
  if (action.type === 'insert' && Array.isArray(currentValue)) {
    if ((action.position ?? 'inside') !== 'inside') return undefined; // before/after interleave → pipeline
    const data = action.data !== undefined ? action.data : action.value;
    const arr = currentValue as unknown[];
    if (typeof action.key === 'number') {
      const next = [...arr];
      next.splice(Math.max(0, Math.min(next.length, action.key)), 0, data);
      return { value: next as TData, mutations: 1, matched: 0, affectedPaths: null };
    }
    return { value: [...arr, data] as TData, mutations: 1, matched: 0, affectedPaths: null };
  }

  // delete_key on an array of flat items: identical to the pipeline's deep
  // strip because flat items cannot hide the key at depth > 1.
  if (action.type === 'delete_key' && Array.isArray(currentValue)) {
    const key = action.key;
    if (typeof key !== 'string' || key.length === 0) return undefined;
    const arr = currentValue as unknown[];
    for (const item of arr) {
      if (item !== null && typeof item === 'object' && !isPlainFlatObject(item)) return undefined;
    }
    const next = arr.map((item) => {
      if (item === null || typeof item !== 'object') return item;
      const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
      delete copy[key];
      return copy;
    });
    return { value: next as TData, mutations: 1, matched: 0, affectedPaths: null };
  }

  // insert_to 'inside' an existing array — append via COW spine.
  if (
    action.type === 'insert_to' &&
    (action.mode === 'inside' || action.mode == null) &&
    action.key == null &&
    typeof action.position === 'string' && action.position.length > 0 &&
    currentValue !== null && typeof currentValue === 'object'
  ) {
    const next = applyInsertToInsideArrayCow(currentValue, action.position, action.data);
    if (next !== undefined) return { value: next as TData, mutations: 1, matched: 0, affectedPaths: null };
  }

  return undefined;
}

/* ========================================================================== */
/*               Sugar deep patch (where + update({patch})) hosts              */
/* ========================================================================== */

/** update({patch}) / replace({patch}) sugar on object trees (key is the patch). */
export function isDeepSugarAction(action: unknown): boolean {
  const a = action as { type?: unknown; key?: unknown } | null;
  return !!a && (a.type === 'update' || a.type === 'replace') && (typeof a.key === 'object' || a.key == null);
}

/**
 * Sugar deep update: where('deep.path.to.leaf', op, X) + update({patch}).
 * The patch is applied at the PARENT object of the leaf named by the last
 * where segment; when the leaf exists but is null/undefined the patch object
 * replaces the leaf slot itself. This form is not representable in the raw
 * pipeline (action keys must be string paths), so this helper is the
 * canonical semantics for every host. Input is never mutated.
 */
export function applyDeepSugarPatch(current: unknown, criteria: ReadonlyArray<unknown>, actions: ReadonlyArray<unknown>): unknown {
  if (current === null || typeof current !== 'object') return current;

  const compiledCriteria = criteria as CompiledCriterion[];
  const strictCtx = { warnedUnknownOps: new Set<string>(), warnings: [] as string[] };
  if (!criteriaMatch(compiledCriteria, current, FASTPATH_OPTIONS, strictCtx)) return current;

  // Clone once (deep structures in the sugar cases are small).
  const result: any = cloneJson(current as object);

  const sugarActions = (actions as Array<{ key?: unknown; value?: unknown }>).filter(isDeepSugarAction);
  if (sugarActions.length === 0) return result;

  for (const crit of compiledCriteria) {
    const segs: string[] = Array.isArray(crit?.segments) ? (crit.segments as string[]) : [];
    if (segs.length === 0) continue;

    // Parent path of the leaf targeted by the where (owner of the matched prop).
    const parentSegs = createJsonPathPlanFromSegments(segs).parentSegments;

    // Replace-slot only when the last segment key EXISTS on the owner in the
    // ORIGINAL data and its value is null/undefined; absent keys keep the
    // assign-at-parent behavior.
    let isNullOrUndefLeafTarget = false;
    const lastSeg = segs[segs.length - 1];
    if (lastSeg != null) {
      const owner = getBySegments(current, parentSegs);
      if (owner !== null && typeof owner === 'object' && lastSeg in (owner as Record<string, unknown>)) {
        if ((owner as Record<string, unknown>)[lastSeg] == null) isNullOrUndefLeafTarget = true;
      }
    }

    // Resolve (or create) the patch target inside the clone.
    let target: any = result;
    for (const seg of parentSegs) {
      if (target === null || typeof target !== 'object') target = {};
      if (target[seg] === null || typeof target[seg] !== 'object') target[seg] = {};
      target = target[seg];
    }
    if (target === null || typeof target !== 'object') target = result;

    for (const act of sugarActions) {
      const patch = (act.key && typeof act.key === 'object') ? act.key : (act.value || {});
      if (patch && typeof patch === 'object') {
        if (lastSeg != null && isNullOrUndefLeafTarget) {
          target[lastSeg] = patch;
        } else {
          Object.assign(target, patch);
        }
      }
    }
  }

  return result;
}
