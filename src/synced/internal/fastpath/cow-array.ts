/**
 * Host-commit fast path for `store.mutate(where(...), update(...))`-style calls. Hosts normally
 * deep-clone the branch, run the pipeline on the clone and commit it; for the #1 real-world shape
 * (a flat array filtered by non-deep criteria and mutated only with value actions) that clones
 * thousands of untouched items. This computes the same result copy-on-write: a new outer array,
 * matched items cloned and mutated via the same `core/actions` appliers, untouched items shared.
 *
 * Identity contract: the returned array is OWNED by the caller's store commit. Unmatched elements
 * alias the input (which is never mutated), so treat the output as the next store state, not a deep snapshot.
 *
 * Guards mirror the pipeline's flat-array fast path (same nested-candidate probe): whenever DFS
 * could match a nested node we return undefined and the caller runs the full pipeline.
 */
import type { Action } from '../types/actions';
import { applyValueAction, isValueAction, prepareActions } from '../../core/actions';
import { compileFlatMutation } from '../../core/compiled-mutation';
import { cloneJson } from '../tree-utils';
import { createStats } from '../run-options';
import { isSingleSegmentKey } from '../codegen/common';
import {
  collectPipelineIntent, flatMatcher, hasNestedCriterionCandidate, isFlatScanEligible, isFlatScanShape, newStrictContext,
  FASTPATH_OPTIONS, type FastMutationOptions, type FastMutationResult, type PipelineIntent,
} from './shared';
import { keyOf, sugarPatchOf, type SugarPatch } from './structural';

/** Concrete single-segment string keys of value actions, or null when any action is not that shape. */
function preciseActionKeys(actions: ReadonlyArray<Action>): string[] | null {
  const keys: string[] = [];
  for (const action of actions) {
    const key = keyOf(action);
    if (!isValueAction(action.type) || !isSingleSegmentKey(key)) return null;
    keys.push(key);
  }
  return keys;
}

function cloneFlatItem(item: unknown): unknown {
  return Array.isArray(item) ? item.slice() : { ...(item as Record<string, unknown>) };
}

function appendAffectedPaths(paths: string[], index: number, keys: ReadonlyArray<string>): void {
  const itemPath = String(index);
  paths.push(itemPath);
  for (const key of keys) paths.push(`${itemPath}.${key}`);
}

const isFastPathAction = (action: Action): boolean => {
  const key = keyOf(action);
  return !!sugarPatchOf(action) || (isValueAction(action.type) && typeof key === 'string' && key.length > 0);
};

function canFastPath(currentValue: unknown, intent: PipelineIntent): currentValue is unknown[] {
  if (intent.optionsTouched || !Array.isArray(currentValue)) return false;
  if (intent.criteria.length === 0 || intent.actions.length === 0) return false;
  return intent.actions.every(isFastPathAction) && isFlatScanEligible(currentValue, intent.criteria, FASTPATH_OPTIONS);
}

/**
 * Affected leaf paths (relative to the branch) for the flat value-action shape, so a host can wake
 * exactly the changed leaves ("grained" wake). Returns null whenever the shape is not the guarded
 * fast path (same guards as tryFastPipelineMutation): the caller then commits the whole branch.
 * Pure read; shared by every host so fine-grained wake stays identical across engines.
 */
export function collectFlatValueActionPaths(currentValue: unknown, ops: ReadonlyArray<unknown>): string[] | null {
  if (!Array.isArray(currentValue)) return null;
  const intent = collectPipelineIntent(ops);
  if (intent.optionsTouched || intent.actions.length === 0 || !isFlatScanShape(intent.criteria, FASTPATH_OPTIONS)) return null;
  // Only concrete string-key value actions (no sugar patch objects, no structural ops).
  const keys = preciseActionKeys(intent.actions);
  // If a nested descendant could also match, the flat scan would diverge from DFS — bail.
  if (!keys || hasNestedCriterionCandidate(currentValue, intent.criteria, FASTPATH_OPTIONS)) return null;

  const matches = flatMatcher(intent.criteria, FASTPATH_OPTIONS, newStrictContext());
  const paths: string[] = [];
  for (let index = 0; index < currentValue.length; index++) {
    if (matches(currentValue[index])) appendAffectedPaths(paths, index, keys);
  }
  return paths;
}

/** Try the COW flat-array mutation; undefined whenever the shape is not the guarded hot path (run the full pipeline then). */
export function tryFastPipelineMutation<TData = unknown>(
  currentValue: TData,
  ops: ReadonlyArray<unknown>,
  options: FastMutationOptions = {}
): FastMutationResult<TData> | undefined {
  return fastFlatMutation(currentValue, collectPipelineIntent(ops), options);
}

/** {@link tryFastPipelineMutation} on an intent already collected (the fast cascade collects it once). */
export function fastFlatMutation<TData = unknown>(
  currentValue: TData,
  intent: PipelineIntent,
  options: FastMutationOptions = {}
): FastMutationResult<TData> | undefined {
  if (!canFastPath(currentValue, intent)) return undefined;

  const patches = intent.actions.map(sugarPatchOf).filter((patch): patch is SugarPatch => patch !== null);
  const preciseKeys = patches.length > 0 ? null : preciseActionKeys(intent.actions);
  const affectedPaths = options.collectAffectedPaths !== false && preciseKeys ? [] as string[] : null;
  const clone = preciseKeys === null ? cloneJson : cloneFlatItem;
  // Throwaway stats/ctx: applyValueAction records into them; hosts only need the value.
  const stats = createStats();
  const items: unknown[] = currentValue;
  let matched = 0;
  let mutations = 0;

  // Whole-loop codegen for static-value actions (no function values, deep merge or sugar): `next` is a
  // shallow copy of the input and only matched slots are replaced with clones (COW identity contract).
  const compiledMutation = patches.length > 0 ? null : compileFlatMutation<unknown>(intent.criteria, intent.actions);
  if (compiledMutation) {
    const next = items.slice();
    const results = compiledMutation(next, {
      immutable: true,
      dryRun: false,
      needPaths: affectedPaths !== null,
      strictPathsWarn: false,
      clone,
      trackOperations: false,
      collectResults: affectedPaths !== null,
    }, stats);
    matched = stats.resultsFound;
    mutations = stats.replaces + stats.updates + stats.mergeUpdates + stats.deletedKeys;
    if (affectedPaths && preciseKeys) {
      for (const node of results) appendAffectedPaths(affectedPaths, Number(node.parentKey), preciseKeys);
    }
    return { value: (matched > 0 ? next : items) as TData, mutations, matched, affectedPaths };
  }

  // Interpreter fallback (function values, merge_update, sugar patches, etc.).
  const prepared = prepareActions(intent.actions.filter((action) => sugarPatchOf(action) === null));
  const matches = flatMatcher(intent.criteria, FASTPATH_OPTIONS, newStrictContext(stats.warnings));
  const next: unknown[] = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === null || typeof item !== 'object' || !matches(item)) {
      next[i] = item;
      continue;
    }
    matched++;
    const copy = clone(item);
    for (const patch of patches) Object.assign(copy as SugarPatch, patch);
    mutations += patches.length;
    for (const action of prepared) {
      if (applyValueAction(copy, action, FASTPATH_OPTIONS, stats)) mutations++;
    }
    next[i] = copy;
    if (affectedPaths && preciseKeys) appendAffectedPaths(affectedPaths, i, preciseKeys);
  }

  return { value: (matched > 0 ? next : items) as TData, mutations, matched, affectedPaths };
}
