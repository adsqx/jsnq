/**
 * The three ways a pipeline collects matches:
 * - `searchOnly`: no actions and no paths -> lean `{ data, depth }` nodes;
 * - `scanMatches`: DFS with per-match actions (the general case);
 * - `sequentialMatches`: deep `@` array criteria, which fan a node out into nested elements.
 */
import type { CompiledCriterion } from '../types/operators';
import type { SearchOptions } from '../types/options';
import type { SearchResultNode } from '../types/pipeline';
import type { PipelineStats } from '../types/stats';
import type { PreparedAction } from '../../core/actions';
import type { RunCtx } from './context';
import type { CriteriaPlan } from './criteria';
import { resolveTraversal, type Traversal } from '../run-options';
import { applyNodeActions } from './apply';
import { criterionMatches } from '../../core/match';
import { deepArrayIterator, dfsIterator, getBySegments, isObject, scanJsonMatches } from '../../core/utils';

export interface SearchRun {
  ctx: RunCtx;
  criteria: ReadonlyArray<CompiledCriterion>;
  plan: CriteriaPlan;
  traversal: Traversal;
  needMeta: boolean;
  needPaths: boolean;
  limit: number | undefined;
  /** Actions applied per matched node (value + node phase; null when there are none). */
  steps: PreparedAction[] | null;
  /** Apply node actions only after the whole match set is known (see `defer` in the action registry). */
  defer: boolean;
}

/** Match collection without actions or result paths. */
export function searchOnly(data: unknown, { match }: CriteriaPlan, options: Readonly<SearchOptions>, stats: PipelineStats, limit: number | undefined): SearchResultNode[] {
  const out: SearchResultNode[] = [];
  const traversal = resolveTraversal(options);
  const { maxDepth, includeArrays } = traversal;

  // Top-level fast path: with maxDepth 1 an array root cannot be descended into, so the full DFS
  // would only ever check the root + its direct items. Iterate them directly (no stack frames or
  // child pushes), which is near-native for flat filtering. Stats are updated live like the DFS.
  if (maxDepth === 1 && Array.isArray(data) && includeArrays) {
    stats.maxDepth = Math.max(stats.maxDepth, 1);
    stats.nodesVisited++; // root array node, checked first (depth 0)
    if (match(data)) {
      stats.resultsFound++;
      out.push({ data, depth: 0 });
      if (limit && out.length >= limit) return out;
    }
    for (let i = 0; i < data.length; i++) {
      stats.nodesVisited++;
      const node: unknown = data[i];
      if (match(node)) {
        stats.resultsFound++;
        out.push({ data: node, depth: 1 });
        if (limit && out.length >= limit) break;
      }
    }
    return out;
  }

  const scan = scanJsonMatches(data, { ...traversal, buildMeta: false, returnPaths: false }, match, (node) => {
    stats.resultsFound++;
    out.push(node);
    if (limit && out.length >= limit) return false;
  });
  stats.nodesVisited += scan.nodesVisited;
  stats.maxDepth = Math.max(stats.maxDepth, scan.maxDepth);
  return out;
}

/** DFS collecting matches; applies node actions per match unless they are deferred. */
export function scanMatches(data: unknown, run: SearchRun): SearchResultNode[] {
  const { ctx, plan, traversal, needMeta, needPaths, limit, steps, defer } = run;
  const out: SearchResultNode[] = [];
  const { match } = plan;
  // The arrow (one shared function, unlike the per-query predicates) keeps scanJsonMatches' predicate
  // call site monomorphic across queries; passing `match` directly measured slower on the bench.
  const scan = scanJsonMatches(data, { ...traversal, buildMeta: needMeta, returnPaths: needPaths }, (node) => match(node), (node) => {
    ctx.stats.resultsFound++;
    if (steps && !defer) applyNodeActions(ctx, node, steps);
    out.push(node);
    if (limit && out.length >= limit) return false;
  });
  ctx.stats.nodesVisited += scan.nodesVisited;
  ctx.stats.maxDepth = Math.max(ctx.stats.maxDepth, scan.maxDepth);
  return out;
}

/** DFS for deep `@` array criteria: each visited node is matched criterion by criterion. */
export function sequentialMatches(data: unknown, run: SearchRun): SearchResultNode[] {
  const { ctx, traversal, needMeta, needPaths, limit } = run;
  const out: SearchResultNode[] = [];
  const seen = { objects: new WeakSet<object>(), pathKeys: new Set<string>() };
  for (const node of dfsIterator(data, { ...traversal, buildMeta: needMeta, returnPaths: needPaths })) {
    ctx.stats.nodesVisited++;
    ctx.stats.maxDepth = Math.max(ctx.stats.maxDepth, node.depth);
    if (matchNode(node, run, seen, out) && limit && out.length >= limit) break;
  }
  return out;
}

interface SeenDeep { objects: WeakSet<object>; pathKeys: Set<string> }

/** Each deep arrayKey criterion descends into nested elements; returns whether a new result was emitted. */
function matchNode(node: SearchResultNode, run: SearchRun, seen: SeenDeep, out: SearchResultNode[]): boolean {
  const { ctx, criteria, traversal, steps, defer } = run;
  let current: SearchResultNode[] = [node];
  for (const c of criteria) {
    const next: SearchResultNode[] = [];
    for (const item of current) {
      if (c.isDeep && c.deepArrayKey) {
        for (const deepNode of deepArrayIterator(item.data, c.deepArrayKey, c.segments, c.opFn, c.value, item.path || [], item.depth, traversal.maxDepth)) {
          next.push(deepNode);
        }
      } else if (c.isDeep) {
        // @id criterion - check the current node
        if (c.opFn(getBySegments(item.data, c.segments), c.value)) next.push(item);
      } else if (criterionMatches(c, item.data)) {
        next.push(item);
      }
    }
    if (next.length === 0) return false;
    current = next;
  }
  let emitted = false;
  for (const found of current) {
    if (!markSeen(found, seen)) continue;
    ctx.stats.resultsFound++;
    if (steps && !defer) applyNodeActions(ctx, found, steps);
    out.push(found);
    emitted = true;
  }
  return emitted;
}

/** True the first time a result is seen (deep criteria can reach one element through several nodes). */
function markSeen(node: SearchResultNode, seen: SeenDeep): boolean {
  if (isObject(node.data)) {
    if (seen.objects.has(node.data)) return false;
    seen.objects.add(node.data);
    return true;
  }
  const pathKey = node.path?.join('\u0000') ?? `${node.depth}:${String(node.data)}`;
  if (seen.pathKeys.has(pathKey)) return false;
  seen.pathKeys.add(pathKey);
  return true;
}
