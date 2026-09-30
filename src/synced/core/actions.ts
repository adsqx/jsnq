import type { Action, PipelineStats, SearchOptions } from './types';
import type { ActionMap } from '../internal/types/actions';
import { createJsonPathPlan, type JsonPathPlan } from './data-engine';
import { ACTIONS, isValueAction as isRegisteredValueAction, type ValueActionType as RegisteredValueType, type ValueSpec } from '../internal/action-registry';
import { valueLabel, type PreparedOf } from '../internal/pipeline/value-actions';

export { computeMergedValue } from '../internal/pipeline/value-actions';

/**
 * Shared application of the "value" actions (replace / update / merge_update /
 * delete_key) against a single matched node. Used by both the DFS pipeline and
 * the flat-array fast path so the semantics, warnings and stats stay identical.
 * Which actions are value actions, and the stat each bumps, come from the action registry.
 *
 * Actions are prepared once per execute(): the path is compiled to a JsonPathPlan
 * up front, so per-node application never re-parses paths, and single-segment
 * keys take a direct property access fast path.
 */

type ValueActionType = 'replace' | 'update' | 'merge_update' | 'delete_key';
// Compile-time check (no runtime output): errors if this list drifts from the registry's 'value' phase.
type _ValueTypesMatch<T extends true> = T;
type _AssertValueTypes = _ValueTypesMatch<[ValueActionType] extends [RegisteredValueType] ? ([RegisteredValueType] extends [ValueActionType] ? true : false) : false>;

export function isValueAction(type: Action['type']): type is ValueActionType {
  return isRegisteredValueAction(type);
}

export interface PreparedAction {
  action: Action;
  /** Compiled plan for the action's key; null for non-value actions. */
  plan: JsonPathPlan | null;
  /** Single-segment key for direct property access; null when the path is deeper. */
  single: string | null;
}

const isValueAct = (a: Action): a is ActionMap[ValueActionType] => isRegisteredValueAction(a.type);

/**
 * Value action prepared by `prepareAction`: carries its registry spec and the constant operation-log
 * line (built once here instead of per hit), so the hot loop dispatches with one property call.
 */
class PreparedValue<K extends ValueActionType> implements PreparedOf<K> {
  constructor(
    readonly action: ActionMap[K],
    readonly plan: JsonPathPlan,
    readonly single: string | null,
    private readonly spec: ValueSpec<K>,
    private readonly label: string,
  ) {}

  run(target: unknown, options: Readonly<SearchOptions>, stats: PipelineStats): void {
    this.spec.apply(target, this, options, stats);
    stats[this.spec.stat]++;
    if (options.trackOperations !== false) stats.operations.push(this.label);
  }
}

// One generic call site: the handlers' bivariant parameters let a union of value actions through without casts.
function bind<K extends ValueActionType>(action: ActionMap[K], spec: ValueSpec<K>, plan: JsonPathPlan, single: string | null): PreparedValue<K> {
  return new PreparedValue(action, plan, single, spec, valueLabel(action, plan.path));
}

export function prepareAction(action: Action): PreparedAction {
  if (!isValueAct(action)) return { action, plan: null, single: null };
  const plan = createJsonPathPlan(action.key);
  return bind(action, ACTIONS[action.type], plan, plan.segments.length === 1 ? plan.segments[0] : null);
}

export function prepareActions(actions: ReadonlyArray<Action>): PreparedAction[] {
  return actions.map(prepareAction);
}

/**
 * Apply a prepared value action to `target`. Returns false when the action is
 * not a value action (caller handles structural actions itself).
 */
export function applyValueAction(
  target: unknown,
  prepared: PreparedAction,
  options: Readonly<SearchOptions>,
  stats: PipelineStats
): boolean {
  if (prepared instanceof PreparedValue) {
    prepared.run(target, options, stats);
    return true;
  }
  // Hand-built PreparedAction (not from prepareAction): bind on the fly.
  const { action, plan, single } = prepared;
  if (!isValueAct(action) || plan === null) return false;
  bind(action, ACTIONS[action.type], plan, single).run(target, options, stats);
  return true;
}
