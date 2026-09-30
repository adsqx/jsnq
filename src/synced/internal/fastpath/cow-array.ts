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
 * Unmatched elements alias the input, so the input itself is never mutated, but
 * the output must be treated as the next store state, not as a deep snapshot.
 *
 * Guards mirror the pipeline's flat-array fast path (same nested-candidate
 * probe): whenever DFS could match a nested node we return undefined and the
 * caller falls back to the full pipeline — semantics stay identical.
 */
import type { Action } from '../../core/types';
import { applyValueAction, isValueAction, prepareActions } from '../../core/actions';
import { compileFlatMutation } from '../../core/compiled-mutation';
import { cloneJson } from '../../core/utils';
import { createStats } from '../run-options';
import { isSingleSegmentKey } from '../codegen/common';
import { hasNestedCriterionCandidate, isFlatScanEligible, isFlatScanShape } from './guard';
import { collectPipelineIntent } from './intent';
import { flatMatcher, newStrictContext } from './matcher';
import { sugarPatchOf } from './sugar';
import type { SugarPatch } from './sugar';
import { FASTPATH_OPTIONS } from './types';
import type { FastMutationOptions, FastMutationResult, PipelineIntent } from './types';

const keyOf = (action: Action): unknown => ('key' in action ? action.key : undefined);

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

function isFastPathAction(action: Action): boolean {
  if (sugarPatchOf(action)) return true;
  const key = keyOf(action);
  return isValueAction(action.type) && typeof key === 'string' && key.length > 0;
}

function canFastPath(currentValue: unknown, intent: PipelineIntent): currentValue is unknown[] {
  if (intent.optionsTouched || !Array.isArray(currentValue)) return false;
  if (intent.criteria.length === 0 || intent.actions.length === 0) return false;
  return intent.actions.every(isFastPathAction) && isFlatScanEligible(currentValue, intent.criteria, FASTPATH_OPTIONS);
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

  const patches = intent.actions.map(sugarPatchOf).filter((patch): patch is SugarPatch => patch !== null);
  const preciseKeys = patches.length > 0 ? null : preciseActionKeys(intent.actions);
  const affectedPaths = options.collectAffectedPaths !== false && preciseKeys ? [] as string[] : null;
  const clone = preciseKeys === null ? cloneJson : cloneFlatItem;
  // Throwaway stats/ctx: applyValueAction records into them; hosts only need the value.
  const stats = createStats();
  const items: unknown[] = currentValue;
  let matched = 0;
  let mutations = 0;

  // Whole-loop codegen for static-value actions (no function values, no merge_update, no sugar).
  // `next` is a shallow copy of the input array; compiled mutation replaces only matched
  // slots with clones, preserving the COW identity contract (unmatched items alias the input).
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
