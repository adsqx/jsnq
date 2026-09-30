/** Shared types and constants of the host-commit fast paths. */
import type { Action, CompiledCriterion, SearchOptions } from '../../core/types';

export interface PipelineIntent {
  criteria: CompiledCriterion[];
  actions: Action[];
  /** True when any operator tried to set pipeline options (limit/immutable/...). */
  optionsTouched: boolean;
}

export interface FastMutationResult<TData = unknown> {
  value: TData;
  /** Number of value-action applications (matched items × actions). */
  mutations: number;
  /** Number of items that matched the criteria. */
  matched: number;
  /** Changed paths relative to the branch, or null for non-precise shapes. */
  affectedPaths: string[] | null;
}

export interface FastMutationOptions {
  /**
   * Keep exact changed paths for precise host wakeups. Disable when the caller
   * only commits the returned value; this avoids one result object per match.
   */
  collectAffectedPaths?: boolean;
}

/** Matches JsnqPipeline's constructor defaults — keep in sync with pipeline.ts. */
export const FASTPATH_OPTIONS: Readonly<SearchOptions> = {
  maxDepth: 10,
  includeArrays: true,
  includeObjects: true,
  trackOperations: false, // host-commit fast path never inspects operation labels
};
