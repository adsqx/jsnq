/**
 * The single table of per-action facts: which phase applies it, whether it needs parent/index
 * metadata from the traversal, whether it must wait for the stable match set, and the typed
 * handler. The counter each action bumps lives in ACTION_STAT (run-options). Everything else
 * (META/defer/value sets, dispatch) derives from this table.
 */
import type { Action, ActionMap, ActionType } from './types/actions';
import type { PipelineStats, SearchOptions, SearchResultNode } from './types/model';
import type { RunCtx } from './run-options';
import { applyAssign, applyDeleteKey, applyMerge, type PreparedOf } from './pipeline/value-actions';
import {
  applyDeleteElement, applyInsert, applyInsertTo, applyMoveMatchesOverwrite, applyMoveOrCopy, fanoutApplier,
} from './pipeline/structural-actions';

/** Predicate type with a bivariant parameter (see the note on `apply` below). */
type Pred<A> = { bivarianceHack(a: A): boolean }['bivarianceHack'];

export type ActionPhase = 'value' | 'node' | 'global';

interface SpecBase<K extends ActionType> {
  phase: ActionPhase;
  /** Needs parent/index metadata from the traversal (a predicate when it depends on the action's fields). */
  meta: boolean | Pred<ActionMap[K]>;
  /** Must wait for the stable match set: applying while the DFS still walks could re-visit inserted nodes. */
  defer: boolean;
}

// `apply` is declared with method syntax on purpose: method parameters are bivariant, so one
// generic call site can invoke the handler of a union of action types without casts.
export interface ValueSpec<K extends ActionType> extends SpecBase<K> {
  phase: 'value';
  apply(target: unknown, prepared: PreparedOf<K>, options: Readonly<SearchOptions>, stats: PipelineStats): void;
}
export interface NodeSpec<K extends ActionType> extends SpecBase<K> {
  phase: 'node';
  /** True when the action was applied (the caller then bumps its counter). */
  apply(ctx: RunCtx, node: SearchResultNode, action: ActionMap[K]): boolean;
}
export interface GlobalSpec<K extends ActionType> extends SpecBase<K> {
  phase: 'global';
  /** Number of applications to add to the action's counter. */
  apply(ctx: RunCtx, matches: SearchResultNode[], action: ActionMap[K]): number;
}
export type ActionSpec<K extends ActionType> = ValueSpec<K> | NodeSpec<K> | GlobalSpec<K>;

const fanout = (kind: 'move' | 'copy', allTargets: boolean) =>
  ({ phase: 'global', meta: true, defer: false, apply: fanoutApplier(kind, allTargets) }) as const;

export const ACTIONS = {
  replace: { phase: 'value', meta: false, defer: false, apply: applyAssign },
  update: { phase: 'value', meta: false, defer: false, apply: applyAssign },
  merge_update: { phase: 'value', meta: false, defer: false, apply: applyMerge },
  delete_key: { phase: 'value', meta: false, defer: false, apply: applyDeleteKey },
  delete_element: { phase: 'node', meta: true, defer: false, apply: applyDeleteElement },
  insert: { phase: 'node', meta: (a) => !!a.position && a.position !== 'inside', defer: true, apply: applyInsert },
  move: { phase: 'node', meta: true, defer: true, apply: (ctx, node, a) => applyMoveOrCopy(ctx, node, a, 'move') },
  copy: { phase: 'node', meta: false, defer: true, apply: (ctx, node, a) => applyMoveOrCopy(ctx, node, a, 'copy') },
  insert_to: { phase: 'global', meta: false, defer: false, apply: applyInsertTo },
  move_matches: fanout('move', false),
  copy_matches: fanout('copy', false),
  move_first_to_matches: fanout('move', true),
  copy_first_to_matches: fanout('copy', true),
  move_matches_overwrite: { phase: 'global', meta: true, defer: false, apply: applyMoveMatchesOverwrite },
} as const satisfies { readonly [K in ActionType]: ActionSpec<K> };

const isActionType = (type: string): type is ActionType => Object.hasOwn(ACTIONS, type);

type AnySpec = { [K in ActionType]: ActionSpec<K> }[ActionType];

/** Spec of an action, or undefined for an unknown `type` (own keys only: `constructor` etc. are not actions). */
export function specOf(action: { type: string }): AnySpec | undefined {
  return isActionType(action.type) ? ACTIONS[action.type] : undefined;
}

/** Action types whose registry phase is 'value' (derived, so it cannot drift from the table). */
export type ValueActionType = { [K in ActionType]: (typeof ACTIONS)[K]['phase'] extends 'value' ? K : never }[ActionType];

export const isValueAction = (type: string): type is ValueActionType => isActionType(type) && ACTIONS[type].phase === 'value';

function needsMeta<K extends ActionType>(spec: SpecBase<K>, action: ActionMap[K]): boolean {
  return typeof spec.meta === 'function' ? spec.meta(action) : spec.meta;
}

/** True when any action needs parent/index metadata from the traversal. */
export function actionsRequireMeta(actions: ReadonlyArray<Action>): boolean {
  return actions.some((a) => { const spec = specOf(a); return !!spec && needsMeta(spec, a); });
}

/** True when node actions must run after the stable match set is collected. */
export function actionsDeferNodeWork(actions: ReadonlyArray<Action>): boolean {
  return actions.some((a) => specOf(a)?.defer === true);
}
