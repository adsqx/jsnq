import {
  Action,
  CompiledCriterion,
  InsertAction,
  PipelineStats,
  SearchOptions,
  SearchResultNode,
} from './types';
import { cloneJson, isObject } from './utils';
import { criteriaMatch } from './match';
import { compileCriteriaPredicate } from './compiled-predicate';
import { applyValueAction, isValueAction, prepareActions } from './actions';
import { compileFlatMutation } from './compiled-mutation';
import { insertRelative } from './ops';
import { resolveRun, resolveTraversal } from '../internal/run-options';

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
  if (!canUseFlatArrayFastPath(params)) return null;

  const { limit, hasLimit, shouldClone, needPaths } = resolveRun(params.options, params.actions.length);
  const workingData = shouldClone && !params.immutableApplied
    ? cloneJson(params.data)
    : params.data;
  const items = workingData as unknown[];
  const results: SearchResultNode<TData, unknown, string | number>[] = [];
  const isDeleteElementOnly =
    params.actions.length === 1 && params.actions[0].type === 'delete_element';
  const relativeInsert = getRelativeInsert(params.actions);
  const preparedActions = isDeleteElementOnly || relativeInsert ? [] : prepareActions(params.actions);
  const strictCtx = { warnedUnknownOps: params.warnedUnknownOps, warnings: params.stats.warnings };
  // Codegen fast path for the per-item match (null → interpreter; results identical).
  const pred = compileCriteriaPredicate(params.criteria);
  const deleteIndices: number[] = isDeleteElementOnly ? [] : [];

  // Whole-loop codegen: match + mutate in one inlined function. Skip when there is
  // a limit/earlyTermination (compiled loop does not truncate) or when the only
  // action is delete_element (handled by the optimized path below).
  const compiledMutation = !hasLimit && !isDeleteElementOnly && !relativeInsert
    ? compileFlatMutation<unknown>(params.criteria, params.actions)
    : null;
  if (compiledMutation) {
    params.stats.nodesVisited += items.length + 1;
    params.stats.maxDepth = Math.max(params.stats.maxDepth, 1);
    const results = compiledMutation(items, {
      immutable: shouldClone && !params.immutableApplied,
      dryRun: !!params.options.dryRun,
      needPaths,
      strictPathsWarn: !!params.options.strictPathsWarn,
      clone: cloneJson,
      trackOperations: params.options.trackOperations,
    }, params.stats) as SearchResultNode<TData, unknown, string | number>[];
    return {
      data: workingData,
      results,
      immutableApplied: params.immutableApplied || shouldClone,
    };
  }

  params.stats.nodesVisited++;
  params.stats.maxDepth = Math.max(params.stats.maxDepth, 0);

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    params.stats.nodesVisited++;
    params.stats.maxDepth = Math.max(params.stats.maxDepth, 1);

    if (!(pred ? pred(item) : criteriaMatch(params.criteria, item, params.options, strictCtx))) continue;

    params.stats.resultsFound++;
    const node = {
      data: item as TData,
      path: needPaths ? [String(index)] : undefined,
      depth: 1,
      parent: workingData,
      parentKey: index,
    } as SearchResultNode<TData, unknown, string | number>;

    if (isDeleteElementOnly) {
      deleteIndices.push(index);
      results.push(node);
      if (limit && results.length >= limit) break;
      continue;
    }

    if (relativeInsert) {
      results.push(node);
      if (limit && results.length >= limit) break;
      continue;
    }

    for (const prepared of preparedActions) {
      applyValueAction(item, prepared, params.options, params.stats);
    }

    results.push(node);
    if (limit && results.length >= limit) break;
  }

  if (isDeleteElementOnly) {
    params.stats.deletedElements += deleteIndices.length;
    if (!params.options.dryRun) {
      // Matches arrive in ascending index order. Compact once instead of doing
      // N descending splices (which turns deleting half a large array into O(n²)).
      let writeIndex = 0;
      let deleteCursor = 0;
      for (let readIndex = 0; readIndex < items.length; readIndex++) {
        if (deleteCursor < deleteIndices.length && deleteIndices[deleteCursor] === readIndex) {
          deleteCursor++;
          continue;
        }
        items[writeIndex++] = items[readIndex];
      }
      items.length = writeIndex;
    }
    for (const idx of deleteIndices) {
      if (params.options.trackOperations !== false) params.stats.operations.push(`delete_element at ${idx}`);
    }
  }

  if (relativeInsert) {
    const { data, position, key } = relativeInsert;
    for (const node of results) {
      if (!params.options.dryRun && !insertRelative(node, data, position, key, params.options, params.stats)) {
        continue;
      }
      params.stats.inserted++;
      if (params.options.trackOperations !== false) {
        params.stats.operations.push(`insert ${position} ${typeof key === 'number' ? `index=${key}` : (key ?? '')}`);
      }
    }
  }

  return {
    data: workingData,
    results,
    immutableApplied: params.immutableApplied || shouldClone,
  };
}

function canUseFlatArrayFastPath<TData>(params: FastPathParams<TData>): boolean {
  if (!Array.isArray(params.data)) return false;
  if (params.criteria.length === 0 || params.actions.length === 0) return false;
  if (params.options.includeArrays === false) return false;
  if ((params.options.maxDepth ?? 10) < 1) return false;
  if (params.criteria.some((criterion) => criterion.isDeep)) return false;
  if (hasNestedCriterionCandidate(params.data, params.criteria, params.options)) return false;
  return params.actions.every((action) => isValueAction(action.type) || action.type === 'delete_element') ||
    getRelativeInsert(params.actions) !== null;
}

function getRelativeInsert(actions: ReadonlyArray<Action>): InsertAction | null {
  if (actions.length !== 1 || actions[0]?.type !== 'insert') return null;
  const action = actions[0] as InsertAction;
  return action.position === 'before' || action.position === 'after' ? action : null;
}

/**
 * True when any nested descendant (beyond the top-level items) could match the
 * criteria heads — the signal that a flat scan would diverge from full DFS.
 * Shared with pipeline-fastpath.ts so both fast paths bail out identically.
 */
export function hasNestedCriterionCandidate(
  items: unknown[],
  criteria: ReadonlyArray<CompiledCriterion>,
  options: Readonly<SearchOptions>
): boolean {
  const { maxDepth, includeArrays, includeObjects } = resolveTraversal(options);
  if (maxDepth <= 1) return false;

  const firstSegments: string[] = [];
  for (const criterion of criteria) {
    const firstSegment = criterion.segments[0];
    if (firstSegment === undefined) return true;
    firstSegments.push(firstSegment);
  }

  const nodes: object[] = [];
  const depths: number[] = [];

  for (let index = items.length - 1; index >= 0; index--) {
    pushChildContainers(items[index], 1, maxDepth, includeArrays, includeObjects, nodes, depths);
  }

  while (nodes.length > 0) {
    const node = nodes.pop()!;
    const depth = depths.pop()!;
    if (canNodeMatchCriterionHead(node, firstSegments)) {
      return true;
    }
    pushChildContainers(node, depth, maxDepth, includeArrays, includeObjects, nodes, depths);
  }

  return false;
}

function pushChildContainers(
  node: unknown,
  depth: number,
  maxDepth: number,
  includeArrays: boolean,
  includeObjects: boolean,
  nodes: object[],
  depths: number[]
): void {
  if (depth >= maxDepth) return;
  const nextDepth = depth + 1;

  if (Array.isArray(node) && includeArrays) {
    for (let index = node.length - 1; index >= 0; index--) {
      const child = node[index];
      if (!isObject(child)) continue;
      nodes.push(child);
      depths.push(nextDepth);
    }
    return;
  }

  if (isObject(node) && includeObjects) {
    const obj = node as Record<string, unknown>;
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const child = obj[key];
        if (!isObject(child)) continue;
        nodes.push(child);
        depths.push(nextDepth);
      }
    }
  }
}

function canNodeMatchCriterionHead(node: unknown, firstSegments: readonly string[]): boolean {
  for (let index = 0; index < firstSegments.length; index++) {
    const firstSegment = firstSegments[index];
    if (Array.isArray(node)) {
      const itemIndex = Number(firstSegment);
      if (!Number.isNaN(itemIndex) && itemIndex >= 0 && itemIndex < node.length) {
        return true;
      }
      continue;
    }
    if (isObject(node) && firstSegment in node) {
      return true;
    }
  }
  return false;
}
