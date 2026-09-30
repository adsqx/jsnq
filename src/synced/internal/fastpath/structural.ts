/*
 * Single-action structural shortcuts (host fast paths).
 *
 * These used to live only in solid-pipeline-bridge.ts, so Angular paid the full
 * clone+pipeline cost for the same shapes. They are part of the shared library so
 * every host commits the same COW results. Each guard mirrors the pipeline's own
 * semantics exactly (parity-tested):
 *   - insert at array root:    splice at clamped numeric key, else push
 *   - delete_key, no criteria: pipeline strips the key from EVERY object node
 *     at any depth, so we only fast-path arrays of flat items (primitive
 *     values only) where top-level stripping is provably identical
 *   - insert_to 'inside' an existing array: append via COW spine
 * Anything outside a guard returns undefined → caller runs the full pipeline.
 */
import type { Action, ActionMap } from '../types/actions';
import { getBySegments, splitPath } from '../../core/utils';
import { isObject } from '../guards';
import { spliceClamped } from '../splice';
import type { FastMutationResult, PipelineIntent } from './types';

type Container = Record<string, unknown>;

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
