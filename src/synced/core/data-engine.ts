export type { JsonDataPathMode, JsonPathPlan, JsonPlanCacheStats, JsonResolvedParent } from '../internal/path/plan';
export type { JsonMutationKind, JsonMutationResult, JsonMutationResultInit } from '../internal/path/result';
export {
  splitJsonPath, createJsonPathPlanFromSegments, createJsonPathPlan, clearJsonPlanCache, getJsonParentSegments,
  getJsonPlanCacheStats, setJsonPlanCacheLimit,
} from '../internal/path/plan';
export { createMutationResult, getJsonAffectedPaths } from '../internal/path/result';
export {
  deleteJsonPath, getJsonBySegments, hasJsonPath, readJsonPath, resolveJsonParentAndKey, writeJsonPath, writeJsonPathValue,
  JsonDataCursor,
} from '../internal/path/ops';
export { cloneJsonData } from '../internal/path/clone';
