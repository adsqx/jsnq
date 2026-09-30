/** Registry-driven appliers: per-match (node phase, value actions inline) and once-per-run (global phase). */
import type { Action, ActionMap, ActionType } from '../types/actions';
import type { SearchResultNode } from '../types/pipeline';
import type { RunCtx } from './context';
import type { PreparedAction } from '../../core/actions';
import { applyValueAction } from '../../core/actions';
import { specOf, type GlobalSpec, type NodeSpec } from '../action-registry';

// One generic call site per phase: the handlers' bivariant parameters let a union of action types
// through without casts (see the note on ValueSpec in the registry).
function runNode<K extends ActionType>(spec: NodeSpec<K>, ctx: RunCtx, node: SearchResultNode, action: ActionMap[K]): void {
  spec.apply(ctx, node, action);
}

function runGlobal<K extends ActionType>(spec: GlobalSpec<K>, ctx: RunCtx, matches: SearchResultNode[], action: ActionMap[K]): void {
  spec.apply(ctx, matches, action);
}

/** The prepared actions applied per matched node (value + node phase); null when there are none. */
export function nodeSteps(prepared: PreparedAction[] | null): PreparedAction[] | null {
  const steps = prepared?.filter((p) => p.plan !== null || specOf(p.action)?.phase === 'node');
  return steps && steps.length > 0 ? steps : null;
}

/** Apply every step to one matched node, in declaration order. */
export function applyNodeActions(ctx: RunCtx, node: SearchResultNode, prepared: PreparedAction[]): void {
  for (const p of prepared) {
    if (p.plan !== null) {
      applyValueAction(node.data, p, ctx.options, ctx.stats);
      continue;
    }
    const spec = specOf(p.action);
    if (spec?.phase === 'node') runNode(spec, ctx, node, p.action);
  }
}

/** Apply the whole-run actions (insert_to, match fan-out, overwrite) in declaration order. */
export function applyGlobalActions(ctx: RunCtx, actions: ReadonlyArray<Action>, matches: SearchResultNode[]): void {
  for (const a of actions) {
    const spec = specOf(a);
    if (spec?.phase === 'global') runGlobal(spec, ctx, matches, a);
  }
}
