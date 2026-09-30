/** Options, run stats, comparison operators and the pipeline-facing structural types (all public via core/types). */
import type { Action } from './actions';
import type { JsonLike } from './path';

export type ArrayMergeStrategy = 'replace' | 'concat' | 'merge-by-key';

export interface SearchOptions {
  maxDepth?: number;
  includeArrays?: boolean;
  includeObjects?: boolean;
  earlyTermination?: boolean;
  limit?: number;
  buildMeta?: boolean;
  returnPaths?: boolean;
  immutable?: boolean | 'auto'; // true or 'auto' (clone only if there are mutating actions)
  dryRun?: boolean;    // don't mutate; only collect planned operations and stats
  strictPathsWarn?: boolean; // add warnings on implicit path creation or missing segments
  operatorsStrict?: 'warn' | 'throw'; // behavior for unknown comparison operators
  arrayMergeStrategy?: ArrayMergeStrategy; // default: 'replace'
  arrayMergeKey?: string | ((x: unknown) => string | number); // required when strategy = 'merge-by-key'
  overwritePolicy?: 'overwrite' | 'skip' | 'error'; // when inserting into object targets; default: 'overwrite'
  warnOnOverwrite?: boolean; // default: true
  objectOrderWarning?: boolean; // warn that before/after on objects has no stable order semantics; default: true
  /**
   * When false, skips `stats.operations.push(...)` in hot paths. The `operations` array
   * stays initialized (empty) but no string allocation/push happens per action. Default
   * true (preserves public stats API). Host commit fast paths set this to false since
   * they never inspect operation labels — removes O(matches × actions) string allocations
   * from the mutate hot path.
   */
  trackOperations?: boolean; // default: true
}

export interface PipelineStats {
  searchTime: number; nodesVisited: number; resultsFound: number; maxDepth: number;
  replaces: number; updates: number; mergeUpdates: number; deletedKeys: number; deletedElements: number;
  inserted: number; moved: number; copied: number;
  warnings: string[]; operations: string[];
}

export type ComparisonOperator =
  | '==' | '===' | '!=' | '!==' | '>' | '>=' | '<' | '<='
  | 'includes' | '!includes' | 'startsWith' | 'endsWith' | 'regex' | 'isArray' | 'isObject'
  | (string & {});

// Narrow built-in operators by value type (keeps registry extensibility)
export type EqualityOps = '==' | '===' | '!=' | '!==';
export type NumericOps = EqualityOps | '<' | '<=' | '>' | '>=';
export type StringOps = EqualityOps | 'includes' | '!includes' | 'startsWith' | 'endsWith' | 'regex';
export type ArrayOps = EqualityOps | 'includes' | '!includes';
export type ComparisonOps = EqualityOps | '<' | '<=' | '>' | '>=';
export type PatternOps = 'includes' | '!includes' | 'startsWith' | 'endsWith' | 'regex';
export type TypeCheckOps = 'isArray' | 'isObject';

export type OperatorFor<V> =
  V extends number ? ComparisonOps | PatternOps :
  V extends string ? ComparisonOps | PatternOps :
  V extends boolean ? EqualityOps :
  V extends ReadonlyArray<unknown> | unknown[] ? ComparisonOps | PatternOps :
  EqualityOps | TypeCheckOps | (string & {});

export interface CompiledCriterion {
  segments: string[];
  operator: ComparisonOperator;
  value: unknown;
  opFn: (a: unknown, b: unknown) => boolean;
  knownOperator: boolean;
  isDeep?: boolean;
  deepArrayKey?: string;  // array key of a deep `@` search (e.g. "fields", "layout")
}

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
  // Returns a generic PipelineLike<TData> to avoid casts to `this` in implementations
  with(next: { data?: TData; options?: SearchOptions; criteria?: CompiledCriterion[]; actions?: Action[] }): PipelineLike<TData>;
}

/** Metadata attached to JsonOperator functions for optimized detection. */
export interface OperatorMetadata {
  /** Flag indicating if operator performs mutations (vs. queries) */
  __isMutation?: boolean;
  /** Cache key for operator memoization */
  __cacheKey?: string;
}

export type JsonOperator<T extends PipelineLike = PipelineLike> = ((pipeline: T) => T) & Partial<OperatorMetadata>;
