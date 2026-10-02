export { default as JsnqPipeline } from './core/pipeline';
export { PipelineWrapper } from './core/pipeline-wrapper';
export * from './core/types';
export * from './core/data-engine';
export { registerOperator } from './core/operators-registry';
export { setPathCacheLimit, buildPath } from './core/utils';
export {
  tryFastPipelineMutation,
  tryFastStructuralMutation,
  applyInsertToInsideArrayCow,
  applyDeepSugarPatch,
  isDeepSugarAction,
  collectPipelineIntent,
} from './core/pipeline-fastpath';
export type { FastMutationOptions, FastMutationResult, PipelineIntent } from './core/pipeline-fastpath';

export { default as where } from './operators/where';
export { default as replace } from './operators/replace';
export { default as update } from './operators/update';
export { default as mergeUpdate } from './operators/mergeUpdate';
export { default as deleteKey } from './operators/deleteKey';
export { default as deleteElement } from './operators/deleteElement';
export { default as insert } from './operators/insert';
export { default as moveTo } from './operators/moveTo';
export { default as insertTo } from './operators/insertTo';
export { default as moveToMatches } from './operators/moveToMatches';
export { default as moveToMatchesOverwrite } from './operators/moveToMatchesOverwrite';
export { default as copyTo } from './operators/copyTo';
export { default as copyToMatches } from './operators/copyToMatches';
export { default as moveToAll } from './operators/moveToAll';
export { default as copyToAll } from './operators/copyToAll';
export { default as moveToFirstTarget } from './operators/moveToFirstTarget';
export { default as copyToFirstTarget } from './operators/copyToFirstTarget';
export { default as move } from './operators/move';
export { default as copy } from './operators/copy';
export type { RelocateTarget, RelocateOptions } from './operators/move';
export type { WherePredicate } from './operators/where';
