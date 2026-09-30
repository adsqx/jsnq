/** One execute(): criteria analysis, the O(1) root-array insert, and search + action orchestration once the fast paths declined. */
import type { Action, ActionMap, ActionType } from '../types/actions';
import type { CompiledCriterion, SearchOptions, SearchResultNode } from '../types/model';
import type { PreparedAction } from '../../core/actions';
import { compileCriteriaPredicate, type CompiledPredicate } from '../../core/compiled-predicate';
import { criteriaMatch, enforceKnownOperator, type StrictOperatorContext } from '../../core/match';
import { actionsDeferNodeWork, actionsRequireMeta, specOf, type GlobalSpec } from '../action-registry';
import { spliceClamped } from '../guards';
import { ACTION_STAT, resolveTraversal, type RunCtx } from '../run-options';
import {
  applyNodeActions, nodeSteps, scanMatches, searchOnly, sequentialMatches, type CriteriaPlan, type SearchRun,
} from './search';

const MATCH_ALL: CompiledPredicate = () => true;

/**
 * Enforces the strict-operator policy once per execute (instead of once per visited node) and picks
 * the matcher; after this the compiled predicate can replace the interpreter without losing
 * warnings / throw semantics.
 */
export function planCriteria(criteria: ReadonlyArray<CompiledCriterion>, options: Readonly<SearchOptions>, ctx: StrictOperatorContext): CriteriaPlan {
  let hasDeep = false;
  let hasDeepArray = false;
  for (const c of criteria) {
    enforceKnownOperator(c, options, ctx);
    if (c.isDeep) {
      hasDeep = true;
      if (c.deepArrayKey) hasDeepArray = true;
    }
  }
  // The codegen predicate covers shallow, single-segment, built-in-operator criteria (null otherwise,
  // e.g. deep/custom-op criteria or a strict CSP); it mirrors the interpreter exactly.
  const pred = hasDeep ? null : compileCriteriaPredicate(criteria);
  const match = criteria.length === 0 ? MATCH_ALL : pred ?? ((node: unknown) => criteriaMatch(criteria, node, options, ctx));
  return { hasDeep, hasDeepArray, match };
}

/** O(1) path for `insert(x)` (position 'inside') applied straight to a root array, with no criteria. */
export function rootArrayInsert(
  { data: root, options, stats }: RunCtx,
  criteria: ReadonlyArray<CompiledCriterion>,
  actions: ReadonlyArray<Action>,
  needPaths: boolean
): SearchResultNode[] | null {
  if (!Array.isArray(root) || criteria.length !== 0 || actions.length !== 1) return null;
  const action = actions[0];
  if (action.type !== 'insert' || action.position !== 'inside') return null;
  const { data, key } = action;

  if (!options.dryRun) {
    if (typeof key === 'number') spliceClamped(root, key, data);
    else root.push(data);
  }

  stats.nodesVisited++;
  stats.resultsFound++;
  stats.inserted++;
  if (options.trackOperations !== false) stats.operations.push('insert root-array inside');

  // The reported index is the raw numeric key (unclamped), else the appended slot.
  return [{ data, path: needPaths ? [String(typeof key === 'number' ? key : Math.max(0, root.length - 1))] : undefined, depth: 1 }];
}

function runGlobal<K extends ActionType>(spec: GlobalSpec<K>, ctx: RunCtx, matches: SearchResultNode[], action: ActionMap[K]): number {
  return spec.apply(ctx, matches, action);
}

/** Apply the whole-run actions (insert_to, match fan-out, overwrite) in declaration order. */
function applyGlobalActions(ctx: RunCtx, actions: ReadonlyArray<Action>, matches: SearchResultNode[]): void {
  for (const a of actions) {
    const spec = specOf(a);
    if (spec?.phase !== 'global') continue;
    const applied = runGlobal(spec, ctx, matches, a); // read before `+=` so handlers that bump counters themselves are not overwritten
    ctx.stats[ACTION_STAT[a.type]] += applied;
  }
}

export interface RunInput {
  ctx: RunCtx;
  criteria: ReadonlyArray<CompiledCriterion>;
  actions: ReadonlyArray<Action>;
  plan: CriteriaPlan;
  needPaths: boolean;
  limit: number | undefined;
  /** Prepared actions; null exactly when there are no actions. */
  prepared: PreparedAction[] | null;
}

/**
 * Collect matches, then apply node actions (per match, or afterwards when the registry says they
 * must wait for the stable match set) and finally the global actions.
 */
export function runSearch({ ctx, criteria, actions, plan, needPaths, limit, prepared }: RunInput): SearchResultNode[] {
  const { data, options, stats } = ctx;
  if (prepared === null && !needPaths && !plan.hasDeep) return searchOnly(data, plan, options, stats, limit);

  const run: SearchRun = {
    ctx, criteria, plan, needPaths, limit,
    steps: nodeSteps(prepared),
    traversal: resolveTraversal(options),
    needMeta: actionsRequireMeta(actions), // only when actions truly need parent/index metadata
    // Moving/copying while the DFS is still walking the same graph can make an inserted node visible
    // to that iterator and apply the action twice, so such actions wait for the stable match set.
    defer: actionsDeferNodeWork(actions),
  };
  const out = plan.hasDeepArray ? sequentialMatches(data, run) : scanMatches(data, run);
  if (run.steps && run.defer) for (const node of out) applyNodeActions(ctx, node, run.steps);
  applyGlobalActions(ctx, actions, out);
  return out;
}
