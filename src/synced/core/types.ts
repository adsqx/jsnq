/** Public type surface. Definitions live in ../internal/types/*; this module only re-exports them. */
export type * from '../internal/types/path';
export type * from '../internal/types/model';
export type {
  ActionType, Action, BaseAction, InsertPosition,
  ReplaceAction, UpdateAction, MergeUpdateAction, DeleteKeyAction, DeleteElementAction, InsertAction,
  InsertToAction, MoveAction, MoveMatchesAction, MoveMatchesOverwriteAction, CopyAction, CopyMatchesAction,
  MoveFirstToMatchesAction, CopyFirstToMatchesAction,
} from '../internal/types/actions';
