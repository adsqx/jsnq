/** Search + action orchestration for one execute(), after the fast paths declined. */
import type { Action } from '../types/actions';
import type { CompiledCriterion } from '../types/operators';
import type { SearchResultNode } from '../types/pipeline';
import type { PreparedAction } from '../../core/actions';
import type { RunCtx } from './context';
import type { CriteriaPlan } from './criteria';
import { actionsDeferNodeWork, actionsRequireMeta } from '../action-registry';
import { resolveTraversal } from '../run-options';
import { applyGlobalActions, applyNodeActions, nodeSteps } from './apply';
import { scanMatches, searchOnly, sequentialMatches, type SearchRun } from './search';

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
