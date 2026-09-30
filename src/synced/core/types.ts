/**
 * Public type surface. Definitions live in ../internal/types/*; this module only
 * re-exports them so every historical import path keeps resolving.
 */
export type { Primitive, JsonLike, Path, PathWithDepth, Split, PathValue, BracketPath, BracketPathWithDepth, KeyFor } from '../internal/types/path';
export type {
  ComparisonOperator, EqualityOps, NumericOps, StringOps, ArrayOps, ComparisonOps, PatternOps, TypeCheckOps,
  OperatorFor, CompiledCriterion,
} from '../internal/types/operators';
export type {
  ActionType, Action, BaseAction, InsertPosition,
  ReplaceAction, UpdateAction, MergeUpdateAction, DeleteKeyAction, DeleteElementAction, InsertAction,
  InsertToAction, MoveAction, MoveMatchesAction, MoveMatchesOverwriteAction, CopyAction, CopyMatchesAction,
  MoveFirstToMatchesAction, CopyFirstToMatchesAction,
} from '../internal/types/actions';
export type { ArrayMergeStrategy, SearchOptions } from '../internal/types/options';
export type { PipelineStats } from '../internal/types/stats';
export type { SearchResultNode, PipelineLike, JsonOperator, OperatorMetadata } from '../internal/types/pipeline';
