import type {
  Action,
  CompiledCriterion,
  InsertAction,
  PipelineStats,
  SearchOptions,
  SearchResultNode,
} from './types';
import { cloneJson } from './utils';
import { applyValueAction, isValueAction, prepareActions } from './actions';
import { compileFlatMutation } from './compiled-mutation';
import { insertRelative } from './ops';
import { resolveRun } from '../internal/run-options';
import { hasNestedCriterionCandidate, isFlatScanEligible } from '../internal/fastpath/guard';
import { flatMatcher } from '../internal/fastpath/matcher';

export { hasNestedCriterionCandidate };

/**
 * Fast path for the most common large-data shape: a flat root array filtered by
 * non-deep criteria and mutated only with value actions (replace / update /
 * merge_update / delete_key). Skips the generic DFS: a single linear scan with
 * actions prepared once. Falls back (returns null) whenever nested descendants
 * could match the criteria, so results stay identical to the full traversal.
 */

type FastPathParams<TData> = {
  data: TData;
  criteria: ReadonlyArray<CompiledCriterion>;
  actions: ReadonlyArray<Action>;
  options: Readonly<SearchOptions>;
  stats: PipelineStats;
  warnedUnknownOps: Set<string>;
  immutableApplied: boolean;
};

export type FlatArrayFastPathResult<TData> = {
  data: TData;
  results: SearchResultNode<TData, unknown, string | number>[];
  immutableApplied: boolean;
};

export function executeFlatArrayFastPath<TData>(
  params: FastPathParams<TData>
): FlatArrayFastPathResult<TData> | null {
  const { criteria, actions, options, stats } = params;
  const isDeleteElementOnly = actions.length === 1 && actions[0]!.type === 'delete_element';
  const relativeInsert = getRelativeInsert(actions);
  const valueOnly = !isDeleteElementOnly && !relativeInsert;
  if (actions.length === 0 || !(relativeInsert || actions.every(isFlatScanAction))) return null;
  if (!isFlatScanEligible(params.data, criteria, options)) return null;

  const { limit, hasLimit, shouldClone, needPaths } = resolveRun(options, actions.length);
  const workingData = shouldClone && !params.immutableApplied ? cloneJson(params.data) : params.data;
  const items = workingData as unknown[];
  const immutableApplied = params.immutableApplied || shouldClone;

  // Whole-loop codegen: match + mutate in one inlined function. Skipped when there is a
  // limit/earlyTermination (compiled loop does not truncate) or for delete_element / relative insert.
  const compiledMutation = !hasLimit && valueOnly ? compileFlatMutation<unknown>(criteria, actions) : null;
  if (compiledMutation) {
    stats.nodesVisited += items.length + 1;
    stats.maxDepth = Math.max(stats.maxDepth, 1);
    const results = compiledMutation(items, {
      immutable: shouldClone && !params.immutableApplied,
      dryRun: !!options.dryRun,
      needPaths,
      strictPathsWarn: !!options.strictPathsWarn,
      clone: cloneJson,
      trackOperations: options.trackOperations,
    }, stats) as SearchResultNode<TData, unknown, string | number>[];
    return { data: workingData, results, immutableApplied };
  }

  // Interpreter scan. `preparedActions` is empty for delete_element / relative insert, whose
  // effect is applied once after the scan from the collected match nodes.
  const preparedActions = valueOnly ? prepareActions(actions) : [];
  const matches = flatMatcher(criteria, options, { warnedUnknownOps: params.warnedUnknownOps, warnings: stats.warnings });
  const results: SearchResultNode<TData, unknown, string | number>[] = [];
  stats.nodesVisited++;
  if (items.length > 0) stats.maxDepth = Math.max(stats.maxDepth, 1);
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    stats.nodesVisited++;
    if (!matches(item)) continue;

    stats.resultsFound++;
    for (const prepared of preparedActions) applyValueAction(item, prepared, options, stats);
    results.push({
      data: item as TData,
      path: needPaths ? [String(index)] : undefined,
      depth: 1,
      parent: workingData,
      parentKey: index,
    });
    if (limit && results.length >= limit) break;
  }

  if (isDeleteElementOnly) deleteMatched(items, results, options, stats);
  else if (relativeInsert) insertAroundMatched(relativeInsert, results, options, stats);
  return { data: workingData, results, immutableApplied };
}

function deleteMatched(
  items: unknown[],
  results: ReadonlyArray<SearchResultNode<unknown, unknown, string | number>>,
  options: Readonly<SearchOptions>,
  stats: PipelineStats
): void {
  stats.deletedElements += results.length;
  if (!options.dryRun) {
    // Matches arrive in ascending index order. Compact once instead of doing
    // N descending splices (which turns deleting half a large array into O(n²)).
    let writeIndex = 0;
    let cursor = 0;
    for (let readIndex = 0; readIndex < items.length; readIndex++) {
      if (cursor < results.length && results[cursor]!.parentKey === readIndex) {
        cursor++;
        continue;
      }
      items[writeIndex++] = items[readIndex];
    }
    items.length = writeIndex;
  }
  if (options.trackOperations !== false) {
    for (const node of results) stats.operations.push(`delete_element at ${node.parentKey}`);
  }
}

function insertAroundMatched(
  { data, position, key }: InsertAction,
  results: ReadonlyArray<SearchResultNode<unknown, unknown, string | number>>,
  options: Readonly<SearchOptions>,
  stats: PipelineStats
): void {
  for (const node of results) {
    if (!options.dryRun && !insertRelative(node, data, position, key, options, stats)) continue;
    stats.inserted++;
    if (options.trackOperations !== false) {
      stats.operations.push(`insert ${position} ${typeof key === 'number' ? `index=${key}` : (key ?? '')}`);
    }
  }
}

const isFlatScanAction = (action: Action): boolean => isValueAction(action.type) || action.type === 'delete_element';

function getRelativeInsert(actions: ReadonlyArray<Action>): InsertAction | null {
  const action = actions[0];
  return actions.length === 1 && action?.type === 'insert' && (action.position === 'before' || action.position === 'after')
    ? action
    : null;
}
