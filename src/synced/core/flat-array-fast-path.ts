import type { Action, CompiledCriterion, InsertAction, PipelineStats, SearchOptions, SearchResultNode } from './types';
import { cloneJson } from './utils';
import { applyValueAction, isValueAction, prepareActions } from './actions';
import { compileFlatMutation } from './compiled-mutation';
import { insertRelative } from './ops';
import { resolveRun } from '../internal/run-options';
import { flatMatcher, hasNestedCriterionCandidate, isFlatScanEligible } from '../internal/fastpath/shared';

export { hasNestedCriterionCandidate };

/**
 * Fast path for the most common large-data shape: a flat root array filtered by non-deep criteria
 * and mutated only with value actions, delete_element or one relative insert. A single linear scan
 * with actions prepared once instead of the generic DFS; returns null whenever nested descendants
 * could match, so results stay identical to the full traversal.
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

export type FlatArrayFastPathResult<TData> = { data: TData; results: SearchResultNode<TData, unknown, string | number>[]; immutableApplied: boolean };

export function executeFlatArrayFastPath<TData>(params: FastPathParams<TData>): FlatArrayFastPathResult<TData> | null {
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

  // Whole-loop codegen (match + mutate in one inlined function); skipped with a limit/earlyTermination
  // (the compiled loop cannot truncate) and for delete_element / relative insert.
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

  // Interpreter scan. delete_element / relative insert have no prepared actions: they are applied once after the scan.
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

type Matches = ReadonlyArray<SearchResultNode<unknown, unknown, string | number>>;

function deleteMatched(items: unknown[], results: Matches, options: Readonly<SearchOptions>, stats: PipelineStats): void {
  stats.deletedElements += results.length;
  if (!options.dryRun) {
    // Matches arrive in ascending index order: compact once instead of N descending splices (O(n²) for half a large array).
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

function insertAroundMatched({ data, position, key }: InsertAction, results: Matches, options: Readonly<SearchOptions>, stats: PipelineStats): void {
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
