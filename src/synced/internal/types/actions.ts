/**
 * Action shapes and the `ActionMap` discriminant table.
 *
 * `ActionMap` maps each action `type` string to its specific interface, so typed
 * dispatch tables can be written without casts:
 *
 *   const handlers: { [K in ActionType]: (a: ActionMap[K], ...) => void } = { ... };
 *   `Action` is the union of all values of `ActionMap`.
 */
import type { ComparisonOperator } from './operators';

export type InsertPosition = 'inside' | 'before' | 'after';

// Helper types for action properties
type ActionKey = string | number;
type ActionValue = unknown | ((current: unknown, node: unknown) => unknown);
type ActionMode = InsertPosition | undefined;

export interface BaseAction { type: ActionType; }

/**
 * Shared shape of the move/copy "matches" action family: select targets by
 * (targetKey, targetOperator, targetValue) and insert with mode/key semantics.
 * key: array index for inside on arrays; string key for objects.
 */
interface TargetMatchAction<T extends ActionType> extends BaseAction {
  type: T;
  targetKey: string;
  targetOperator: ComparisonOperator;
  targetValue: unknown;
  mode?: ActionMode;
  key?: ActionKey;
}

export interface ReplaceAction extends BaseAction {
  type: 'replace';
  key: string;
  value: ActionValue;
}

export interface UpdateAction extends BaseAction {
  type: 'update';
  key: string;
  value: ActionValue;
}

export interface MergeUpdateAction extends BaseAction {
  type: 'merge_update';
  key: string;
  patch: Record<string, unknown>;
  deep?: boolean; // optional deep merge flag
}

export interface DeleteKeyAction extends BaseAction { type: 'delete_key'; key: string; }
export interface DeleteElementAction extends BaseAction { type: 'delete_element'; }

export interface InsertAction extends BaseAction {
  type: 'insert';
  data: unknown;
  position: InsertPosition;
  key?: ActionKey; // string for object key; number = array index when inside
}

export interface MoveAction extends BaseAction {
  type: 'move';
  position: string;
  mode?: ActionMode;
  key?: ActionKey; // when inside and target is array: numeric index
}

export interface InsertToAction extends BaseAction {
  type: 'insert_to';
  data: unknown;
  position: string;
  mode?: ActionMode;
  key?: ActionKey; // when inside and target is array: numeric index
}

export interface MoveMatchesAction extends TargetMatchAction<'move_matches'> {}

export interface MoveMatchesOverwriteAction extends BaseAction {
  type: 'move_matches_overwrite';
  targetKey: string;
  targetOperator: ComparisonOperator;
  targetValue: unknown;
  overwriteKey: string;
}

export interface CopyAction extends BaseAction {
  type: 'copy';
  position: string;
  mode?: ActionMode;
  key?: ActionKey; // when inside and target is array: numeric index
}

export interface CopyMatchesAction extends TargetMatchAction<'copy_matches'> {}

export interface MoveFirstToMatchesAction extends TargetMatchAction<'move_first_to_matches'> {}

export interface CopyFirstToMatchesAction extends TargetMatchAction<'copy_first_to_matches'> {}

/**
 * Discriminant table: action `type` string -> specific action interface.
 * (Key order is deliberate: it keeps the printed `ActionType` union stable in emitted typings.)
 */
export interface ActionMap {
  move_matches: MoveMatchesAction;
  copy_matches: CopyMatchesAction;
  move_first_to_matches: MoveFirstToMatchesAction;
  copy_first_to_matches: CopyFirstToMatchesAction;
  merge_update: MergeUpdateAction;
  replace: ReplaceAction;
  update: UpdateAction;
  delete_key: DeleteKeyAction;
  delete_element: DeleteElementAction;
  insert: InsertAction;
  insert_to: InsertToAction;
  move: MoveAction;
  move_matches_overwrite: MoveMatchesOverwriteAction;
  copy: CopyAction;
}

export type ActionType = Extract<keyof ActionMap, string>;
/** Union of all actions; equals `ActionMap[ActionType]` (asserted below). Listed explicitly to keep emitted typings stable. */
export type Action =
  | ReplaceAction
  | UpdateAction
  | MergeUpdateAction
  | DeleteKeyAction
  | DeleteElementAction
  | InsertAction
  | InsertToAction
  | MoveAction
  | MoveMatchesAction
  | MoveMatchesOverwriteAction
  | CopyAction
  | CopyMatchesAction
  | MoveFirstToMatchesAction
  | CopyFirstToMatchesAction;

// Compile-time check (type-only, no runtime output): errors if `Action` drifts from `ActionMap`.
type _Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _Assert<T extends true> = T;
type _ActionMatchesMap = _Assert<_Same<Action, ActionMap[ActionType]>>;
