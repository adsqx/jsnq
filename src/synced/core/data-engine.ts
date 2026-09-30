export type {
  JsonDataPathMode,
  JsonMutationKind,
  JsonMutationResult,
  JsonMutationResultInit,
  JsonPathPlan,
  JsonPlanCacheStats,
  JsonResolvedParent,
} from '../internal/path/types';
export { splitJsonPath, createJsonPathPlanFromSegments } from '../internal/path/parse';
export {
  clearJsonPlanCache,
  createJsonPathPlan,
  getJsonParentSegments,
  getJsonPlanCacheStats,
  setJsonPlanCacheLimit,
} from '../internal/path/plan-cache';
export { createMutationResult, getJsonAffectedPaths } from '../internal/path/mutation-result';
export {
  deleteJsonPath,
  getJsonBySegments,
  hasJsonPath,
  readJsonPath,
  resolveJsonParentAndKey,
  writeJsonPath,
  writeJsonPathValue,
} from '../internal/path/json-ops';
export { JsonDataCursor } from '../internal/path/cursor';
export { cloneJsonData } from '../internal/path/clone';
