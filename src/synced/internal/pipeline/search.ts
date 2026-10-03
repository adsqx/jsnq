/**
 * The three ways a pipeline collects matches:
 * - `searchOnly`: no actions and no paths -> lean `{ data, depth }` nodes;
 * - `scanMatches`: DFS with per-match actions (the general case);
 * - `sequentialMatches`: deep `@` array criteria, which fan a node out into nested elements.
 */
import type { ActionMap, ActionType } from '../types/actions';
import type { CompiledCriterion, SearchOptions, PipelineStats, SearchResultNode } from '../types/model';
import type { PreparedAction } from '../../core/actions';
import { applyValueAction } from '../../core/actions';
import { criterionMatches } from '../../core/match';
import { specOf, type NodeSpec } from '../action-registry';
import { isObject } from '../guards';
import { ACTION_STAT, resolveTraversal, type RunCtx, type Traversal } from '../run-options';
import { getBySegments } from '../tree-utils';
import { deepArrayIterator } from '../deep-search';
import { dfsIterator, scanJsonMatches } from '../traverse';
import type { CompiledPredicate } from '../../core/compiled-predicate';

export interface CriteriaPlan {
  /** Some criterion is a deep `@` path. */
  hasDeep: boolean;
  /** Some deep criterion descends into array elements (needs the sequential matcher). */
  hasDeepArray: boolean;
  /** Node matcher: always-true for no criteria, else the codegen predicate, else the interpreter. */
  match: CompiledPredicate;
}

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

// One generic call site per phase: the handlers' bivariant parameters let a union of action types
// through without casts (see the note on ValueSpec in the registry).
function runNode<K extends ActionType>(spec: NodeSpec<K>, ctx: RunCtx, node: SearchResultNode, action: ActionMap[K]): boolean {
  return spec.apply(ctx, node, action);
}

/** The prepared actions applied per matched node (value + node phase); null when there are none. */
export function nodeSteps(prepared: PreparedAction[] | null): PreparedAction[] | null {
  const steps = prepared?.filter((p) => p.plan !== null || specOf(p.action)?.phase === 'node');
  return steps && steps.length > 0 ? steps : null;
}

/** Apply every step to one matched node, in declaration order (value actions log/count themselves; node actions are counted here). */
export function applyNodeActions(ctx: RunCtx, node: SearchResultNode, prepared: PreparedAction[], fresh?: FreshObjects): void {
  for (const p of prepared) {
    if (p.plan !== null) {
      if (fresh !== undefined && mayCreateObjects(p)) applyMarkingFresh(node.data, p, ctx, fresh);
      else applyValueAction(node.data, p, ctx.options, ctx.stats);
      continue;
    }
    const spec = specOf(p.action);
    if (spec?.phase === 'node' && runNode(spec, ctx, node, p.action)) ctx.stats[ACTION_STAT[p.action.type]]++;
  }
}

/**
 * Whether a value action can put a new object into the tree: a path deeper than one key (missing
 * containers are created), an object or computed value, or a merge.
 */
export function mayCreateObjects(p: PreparedAction): boolean {
  const a = p.action as { type: string; value?: unknown };
  if (a.type === 'delete_key') return false;
  if (a.type === 'merge_update' || p.single === null) return true;
  return typeof a.value === 'object' || typeof a.value === 'function';
}

/** Objects created by the running walk's own actions; `has` is a plain counter check until the first one. */
export class FreshObjects {
  private readonly set = new WeakSet<object>();
  private count = 0;
  add(value: unknown): void {
    if (typeof value === 'object' && value !== null) { this.set.add(value); this.count++; }
  }
  has(value: object): boolean {
    return this.count !== 0 && this.set.has(value);
  }
}

const objectsAlong = (root: unknown, segments: readonly string[]): unknown[] => {
  const out: unknown[] = [];
  let node = root;
  for (let i = 0; i < segments.length && typeof node === 'object' && node !== null; i++) {
    node = (node as Record<string, unknown>)[segments[i]!];
    out.push(node);
  }
  return out;
};

const childObjects = (value: unknown): unknown[] =>
  typeof value === 'object' && value !== null ? Object.values(value).filter((v) => typeof v === 'object' && v !== null) : [];

/**
 * Apply a value action and record, in `fresh`, every object it introduced along its path (created
 * containers, the written value, new children of a merged value), so the running walk does not
 * descend into them and re-apply the action to what it just created.
 */
function applyMarkingFresh(target: unknown, p: PreparedAction, ctx: RunCtx, fresh: FreshObjects): void {
  const single = p.single;
  if (single !== null && p.action.type !== 'merge_update') {
    // One key: only the written value itself can be new.
    const holder = target as Record<string, unknown> | null;
    const old = typeof holder === 'object' && holder !== null ? holder[single] : undefined;
    applyValueAction(target, p, ctx.options, ctx.stats);
    const now = typeof holder === 'object' && holder !== null ? holder[single] : undefined;
    if (now !== old) fresh.add(now);
    return;
  }
  const segments = p.plan!.segments;
  const before = objectsAlong(target, segments);
  const mergedBefore = p.action.type === 'merge_update' ? childObjects(before[before.length - 1]) : null;
  applyValueAction(target, p, ctx.options, ctx.stats);
  const after = objectsAlong(target, segments);
  for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) fresh.add(after[i]);
  if (mergedBefore !== null) for (const child of childObjects(after[after.length - 1])) if (!mergedBefore.includes(child)) fresh.add(child);
}

/** Match collection without actions or result paths. */
export function searchOnly(data: unknown, { match }: CriteriaPlan, options: Readonly<SearchOptions>, stats: PipelineStats, limit: number | undefined): SearchResultNode[] {
  const out: SearchResultNode[] = [];
  const traversal = resolveTraversal(options);
  const { maxDepth, includeArrays } = traversal;

  // Top-level fast path: with maxDepth 1 the DFS only checks the root + its direct items, so iterate
  // them directly (no stack frames or child pushes): near-native flat filtering. Stats update live like the DFS.
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
  // The arrow (one shared function, unlike per-query predicates) keeps scanJsonMatches' predicate call
  // site monomorphic across queries; passing `match` directly measured slower.
  // Actions applied while walking must not reach the objects they create (they would re-apply to them).
  const fresh = steps && !defer && steps.some(mayCreateObjects) ? new FreshObjects() : undefined;
  const scan = scanJsonMatches(data, { ...traversal, buildMeta: needMeta, returnPaths: needPaths, skip: fresh }, (node) => match(node), (node) => {
    ctx.stats.resultsFound++;
    if (steps && !defer) applyNodeActions(ctx, node, steps, fresh);
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
