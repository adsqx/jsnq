/** Host-commit fast paths' shared types and constants, plus intent collection (run the operators against a spy to learn criteria/actions without touching data). */
import type { Action } from '../types/actions';
import type { CompiledCriterion, SearchOptions } from '../types/model';

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

/**
 * Minimal pipeline-shaped spy: operators are called with it during collection
 * so we learn the compiled criteria/actions without touching any data.
 */
class IntentCollector {
  criteria: CompiledCriterion[] = [];
  actions: Action[] = [];
  optionsTouched = false;

  with(next: { criteria?: CompiledCriterion[]; actions?: Action[]; options?: unknown }): IntentCollector {
    const out = new IntentCollector();
    out.criteria = next.criteria ?? this.criteria;
    out.actions = next.actions ?? this.actions;
    out.optionsTouched = this.optionsTouched || next.options !== undefined;
    return out;
  }
}

type IntentOperator = (pipeline: IntentCollector) => IntentCollector;

const unsupported = (): PipelineIntent => ({ criteria: [], actions: [], optionsTouched: true });

export function collectPipelineIntent(ops: ReadonlyArray<unknown>): PipelineIntent {
  let collector = new IntentCollector();
  if (ops && ops.length > 0) {
    try {
      for (const op of ops) {
        if (typeof op !== 'function') return unsupported();
        collector = (op as IntentOperator)(collector);
      }
    } catch {
      return unsupported();
    }
  }
  return {
    criteria: Array.isArray(collector.criteria) ? collector.criteria : [],
    actions: Array.isArray(collector.actions) ? collector.actions : [],
    optionsTouched: collector.optionsTouched,
  };
}
