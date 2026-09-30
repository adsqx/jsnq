/**
 * Option derivation, stats lifecycle and the per-action stat table shared by the pipeline and
 * its fast paths. Type-only imports; no runtime dependencies.
 */
import type { ActionType } from './types/actions';
import type { PipelineStats, SearchOptions } from './types/model';

/** Default traversal depth used when `SearchOptions.maxDepth` is unset. */
export const DEFAULT_MAX_DEPTH = 10;

/** Minimal sink for non-fatal warnings; `PipelineStats` satisfies it. */
export interface WarnSink { warnings: string[] }

/** Counters of PipelineStats that are plain numbers. */
export type NumericStat = { [K in keyof PipelineStats]: PipelineStats[K] extends number ? K : never }[keyof PipelineStats];

/** The counter each action type bumps (single source for the registry, the interpreter and the compiled loop). */
export const ACTION_STAT = {
  replace: 'replaces', update: 'updates', merge_update: 'mergeUpdates', delete_key: 'deletedKeys',
  delete_element: 'deletedElements', insert: 'inserted', insert_to: 'inserted',
  move: 'moved', move_matches: 'moved', move_first_to_matches: 'moved', move_matches_overwrite: 'moved',
  copy: 'copied', copy_matches: 'copied', copy_first_to_matches: 'copied',
} as const satisfies { readonly [K in ActionType]: NumericStat };

/** Shared per-execution state handed to node/global action handlers. */
export interface RunCtx {
  /** Root of the working data (already cloned when immutable). */
  readonly data: unknown;
  readonly options: Readonly<SearchOptions>;
  readonly stats: PipelineStats;
}

/** Fresh zeroed stats object (arrays are new instances). */
export function createStats(): PipelineStats {
  return {
    searchTime: 0, nodesVisited: 0, resultsFound: 0, maxDepth: 0,
    replaces: 0, updates: 0, mergeUpdates: 0, deletedKeys: 0, deletedElements: 0,
    inserted: 0, moved: 0, copied: 0, warnings: [], operations: [],
  };
}

/** Zero `s` in place (assigns NEW `warnings`/`operations` arrays) and return it. */
export function resetStats(s: PipelineStats): PipelineStats {
  s.searchTime = 0; s.nodesVisited = 0; s.resultsFound = 0; s.maxDepth = 0;
  s.replaces = 0; s.updates = 0; s.mergeUpdates = 0; s.deletedKeys = 0; s.deletedElements = 0;
  s.inserted = 0; s.moved = 0; s.copied = 0; s.warnings = []; s.operations = [];
  return s;
}

/** Traversal knobs, normalized to concrete values (`maxDepth ?? 10`, `!!includeArrays`, `!!includeObjects`). */
export interface Traversal { maxDepth: number; includeArrays: boolean; includeObjects: boolean }

export function resolveTraversal(options: Readonly<SearchOptions>): Traversal {
  return {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    includeArrays: !!options.includeArrays,
    includeObjects: !!options.includeObjects,
  };
}

/** Per-execution knobs derived from options + action count. */
export interface RunOptions {
  /** `options.limit ?? (earlyTermination ? 1 : undefined)`; check with `limit && n >= limit` like the original. */
  limit: number | undefined;
  /** True when `options.limit` is set or `earlyTermination` is on (compiled loops cannot truncate). */
  hasLimit: boolean;
  /** Clone input before traversal: `immutable === true` or (`'auto'` with at least one action). */
  shouldClone: boolean;
  /** Result nodes need `path`: `returnPaths !== false && (buildMeta || nActions > 0)`. */
  needPaths: boolean;
}

export function resolveRun(options: Readonly<SearchOptions>, nActions: number): RunOptions {
  return {
    limit: options.limit ?? (options.earlyTermination ? 1 : undefined),
    hasLimit: options.limit !== undefined || !!options.earlyTermination,
    shouldClone: options.immutable === true || (options.immutable === 'auto' && nActions > 0),
    needPaths: options.returnPaths !== false && (!!options.buildMeta || nActions > 0),
  };
}
