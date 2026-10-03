/**
 * The fast cascade every host store runs before the full clone + pipeline: the copy-on-write flat
 * mutation, then the single-action structural shortcuts, then the deep sugar patch. One intent
 * collection for all three; undefined when none applies (run the pipeline then).
 */
import { collectPipelineIntent, type FastMutationOptions, type FastMutationResult } from './shared';
import { fastFlatMutation } from './cow-array';
import { applyDeepSugarPatch, isDeepSugarAction, tryFastStructuralMutation } from './structural';

export function tryFastMutation<TData = unknown>(
  currentValue: TData,
  ops: ReadonlyArray<unknown>,
  options: FastMutationOptions = {}
): FastMutationResult<TData> | undefined {
  const intent = collectPipelineIntent(ops);
  const result = fastFlatMutation(currentValue, intent, options) ?? tryFastStructuralMutation(currentValue, intent);
  if (result) return result;
  // where + update({patch}) is not representable in the raw pipeline; the sugar helper defines it.
  if (intent.criteria.length > 0 && intent.actions.length > 0 && intent.actions.every(isDeepSugarAction)) {
    return { value: applyDeepSugarPatch(currentValue, intent.criteria, intent.actions) as TData, mutations: 1, matched: 0, affectedPaths: null };
  }
  return undefined;
}
