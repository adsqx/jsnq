/**
 * Host-commit fast paths (public facade). Implementations live in ../internal/fastpath/*:
 * intent collection, the COW flat-array mutation, single-action structural shortcuts and
 * the deep sugar patch. Every host store imports from here.
 */
export type { PipelineIntent, FastMutationResult, FastMutationOptions } from '../internal/fastpath/types';
export { collectPipelineIntent } from '../internal/fastpath/intent';
export { collectFlatValueActionPaths, tryFastPipelineMutation } from '../internal/fastpath/cow-array';
export { applyInsertToInsideArrayCow, tryFastStructuralMutation } from '../internal/fastpath/structural';
export { applyDeepSugarPatch, isDeepSugarAction } from '../internal/fastpath/sugar';
