/**
 * Public utility facade (every file under core/ is a package entry point). Implementations
 * live in ../internal/*; this file only re-exports them under their stable names.
 */
export { isObject, isRecordObject } from '../internal/guards';
export { splitPath, getBySegments, setByPath, deleteByPath, hasPath, cloneJson, setPathCacheLimit, buildPath } from '../internal/path-facade';
export { dfsIterator, scanJsonMatches } from '../internal/traverse';
export type { TraverseFrame, ScanJsonOptions } from '../internal/traverse';
export { resolveTargetPath, resolveTargetWithPathCreation } from '../internal/target-path';
export type { ResolvedTargetPath } from '../internal/target-path';
export { deepMerge } from '../internal/deep-merge';
export type { DeepMergeOptions } from '../internal/deep-merge';
export { parseDeepSearchPath, deepArrayMatch, deepArrayIterator } from '../internal/deep-search';
export type { DeepSearchPath } from '../internal/deep-search';
