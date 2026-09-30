/** Pipeline-facing structural types: result nodes, PipelineLike and JsonOperator. */

import type { JsonLike } from './path';
import type { CompiledCriterion } from './operators';
import type { Action } from './actions';
import type { SearchOptions } from './options';

// Traversal result node with generics (defaults keep back-compat)
export interface SearchResultNode<TData = unknown, TParent = unknown, TKey extends string | number = string | number> {
  data: TData;
  path?: string[];
  depth: number;
  parent?: TParent;
  parentKey?: TKey;
}

export interface PipelineLike<TData extends JsonLike = JsonLike> {
  readonly data: TData;
  readonly criteria: ReadonlyArray<CompiledCriterion>;
  readonly actions: ReadonlyArray<Action>;
  readonly options: Readonly<SearchOptions>;
  // Return a generic PipelineLike<TData> to avoid casts to `this` in implementations
  with(next: { data?: TData; options?: SearchOptions; criteria?: CompiledCriterion[]; actions?: Action[] }): PipelineLike<TData>;
}

/**
 * Metadata attached to JsonOperator functions for optimized detection
 */
export interface OperatorMetadata {
  /** Flag indicating if operator performs mutations (vs. queries) */
  __isMutation?: boolean;
  /** Cache key for operator memoization */
  __cacheKey?: string;
}

// JsonOperator: a function that accepts a PipelineLike and returns a new PipelineLike
// Operators may have metadata attached for optimization (mutation detection, caching)
export type JsonOperator<T extends PipelineLike = PipelineLike> = ((pipeline: T) => T) & Partial<OperatorMetadata>;
