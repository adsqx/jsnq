/*
 * Single-action structural shortcuts and the `update({patch})` sugar (host fast paths), shared by
 * every host so all commit the same COW results. Each guard mirrors the pipeline's own semantics
 * exactly (parity-tested):
 *   - insert at array root:    splice at clamped numeric key, else push
 *   - delete_key, no criteria: pipeline strips the key from EVERY object node
 *     at any depth, so we only fast-path arrays of flat items (primitive
 *     values only) where top-level stripping is provably identical
 *   - insert_to 'inside' an existing array: append via COW spine
 * Anything outside a guard returns undefined → caller runs the full pipeline.
 */
import type { Action, ActionMap } from '../types/actions';
import type { CompiledCriterion } from '../types/model';
import { cloneJson, getBySegments, splitPath } from '../tree-utils';
import { isObject, isRecordObject, spliceClamped } from '../guards';
import { criteriaMatch } from '../../core/match';
import { createJsonPathPlanFromSegments } from '../../core/data-engine';
import { FASTPATH_OPTIONS, type FastMutationResult, type PipelineIntent } from './intent';
import { newStrictContext } from './guard';

type Container = Record<string, unknown>;
export type SugarPatch = Container;

/** Object whose values are all primitives (no nested containers). */
function isPlainFlatObject(item: object): boolean {
  if (Array.isArray(item)) return false;
  for (const key in item) {
    if (isObject((item as Container)[key])) return false;
  }
  return true;
}

const shallowCopy = (value: object): Container => (Array.isArray(value) ? [...value] : { ...value }) as Container;

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
  const root = shallowCopy(currentValue as object);
  let parent = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const child = parent[seg];
    if (!isObject(child)) return undefined; // unexpected shape → safe fallback
    parent = parent[seg] = shallowCopy(child);
  }
  parent[segs[segs.length - 1]!] = [...target, data];
  return root;
}

type StructuralType = 'insert' | 'delete_key' | 'insert_to';
type StructuralHandlers = { [K in StructuralType]: (current: unknown, action: ActionMap[K]) => unknown };

/** Each handler returns the new root value, or undefined when its guard does not hold. */
const HANDLERS: StructuralHandlers = {
  // insert at an array root — mirrors pipeline's executeRootArrayInsertFastPath.
  insert(current, action) {
    if (!Array.isArray(current)) return undefined;
    if ((action.position ?? 'inside') !== 'inside') return undefined; // before/after interleave → pipeline
    const { data, value } = action as typeof action & { value?: unknown };
    const item = data !== undefined ? data : value;
    if (typeof action.key !== 'number') return [...current, item];
    const next = [...current];
    spliceClamped(next, action.key, item);
    return next;
  },

  // delete_key on an array of flat items: identical to the pipeline's deep
  // strip because flat items cannot hide the key at depth > 1.
  delete_key(current, action) {
    const key = action.key;
    if (!Array.isArray(current) || typeof key !== 'string' || key.length === 0) return undefined;
    for (const item of current) {
      if (isObject(item) && !isPlainFlatObject(item)) return undefined;
    }
    return current.map((item) => {
      if (!isObject(item)) return item;
      const copy = { ...item };
      delete copy[key];
      return copy;
    });
  },

  // insert_to 'inside' an existing array — append via COW spine.
  insert_to(current, action) {
    if (
      (action.mode === 'inside' || action.mode == null) && action.key == null &&
      typeof action.position === 'string' && action.position.length > 0 && isObject(current)
    ) {
      return applyInsertToInsideArrayCow(current, action.position, action.data);
    }
    return undefined;
  },
};

/**
 * Try the criteria-less single-action shortcuts. The result is COW like
 * tryFastPipelineMutation (input never mutated, untouched branches shared).
 */
export function tryFastStructuralMutation<TData = unknown>(
  currentValue: TData,
  intent: PipelineIntent
): FastMutationResult<TData> | undefined {
  if (intent.optionsTouched || intent.criteria.length !== 0 || intent.actions.length !== 1) return undefined;
  const action = intent.actions[0];
  if (!action || !Object.hasOwn(HANDLERS, action.type)) return undefined;
  const handler = HANDLERS[action.type as StructuralType] as (current: unknown, action: Action) => unknown;
  const value = handler(currentValue, action);
  return value === undefined ? undefined : { value: value as TData, mutations: 1, matched: 0, affectedPaths: null };
}

export const keyOf = (action: Action): unknown => ('key' in action ? action.key : undefined);

/** The sugar patch of a flat-array action, or null for any other action. */
export function sugarPatchOf(action: Action): SugarPatch | null {
  if (action.type !== 'update' && action.type !== 'replace') return null;
  const key = keyOf(action);
  return isRecordObject(key) ? key : null;
}

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
  if (!isObject(current)) return current;

  const compiledCriteria = criteria as CompiledCriterion[];
  if (!criteriaMatch(compiledCriteria, current, FASTPATH_OPTIONS, newStrictContext())) return current;

  // Clone once (deep structures in the sugar cases are small).
  const result = cloneJson(current);

  const sugarActions = (actions as Array<{ key?: unknown; value?: unknown }>).filter(isDeepSugarAction);
  if (sugarActions.length === 0) return result;

  for (const crit of compiledCriteria) {
    const segs: string[] = Array.isArray(crit?.segments) ? crit.segments : [];
    if (segs.length === 0) continue;

    // Parent path of the leaf targeted by the where (owner of the matched prop).
    const parentSegs = createJsonPathPlanFromSegments(segs).parentSegments;

    // Replace-slot only when the last segment key EXISTS on the owner in the
    // ORIGINAL data and its value is null/undefined; absent keys keep the
    // assign-at-parent behavior.
    const lastSeg = segs[segs.length - 1];
    let isNullOrUndefLeafTarget = false;
    if (lastSeg != null) {
      const owner = getBySegments(current, parentSegs);
      if (isObject(owner) && lastSeg in owner && owner[lastSeg] == null) isNullOrUndefLeafTarget = true;
    }

    // Resolve (or create) the patch target inside the clone.
    let target: Record<string, unknown> = result;
    for (const seg of parentSegs) {
      if (!isObject(target[seg])) target[seg] = {};
      target = target[seg] as Record<string, unknown>;
    }

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
