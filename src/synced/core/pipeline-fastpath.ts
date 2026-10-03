/** Host-commit fast paths (public facade); implementations live in ../internal/fastpath/*. Every host store imports from here. */
export type { PipelineIntent, FastMutationResult, FastMutationOptions } from '../internal/fastpath/shared';
export { collectPipelineIntent } from '../internal/fastpath/shared';
export { collectFlatValueActionPaths, tryFastPipelineMutation } from '../internal/fastpath/cow-array';
export { tryFastMutation } from '../internal/fastpath/cascade';
export { applyInsertToInsideArrayCow, tryFastStructuralMutation, applyDeepSugarPatch, isDeepSugarAction } from '../internal/fastpath/structural';
