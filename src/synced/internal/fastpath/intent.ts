/** Intent collection: run the operators against a spy to learn criteria/actions without touching data. */
import type { Action, CompiledCriterion } from '../../core/types';
import type { PipelineIntent } from './types';

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
