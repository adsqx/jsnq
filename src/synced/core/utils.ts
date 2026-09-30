/** Public utility facade (every file under core/ is a package entry point); implementations live in ../internal/*. */
export { isObject, isRecordObject } from '../internal/guards';
export {
  splitPath, getBySegments, setByPath, deleteByPath, hasPath, cloneJson, setPathCacheLimit, buildPath,
  resolveTargetPath, resolveTargetWithPathCreation, deepMerge,
} from '../internal/tree-utils';
export type { ResolvedTargetPath, DeepMergeOptions } from '../internal/tree-utils';
export { dfsIterator, scanJsonMatches } from '../internal/traverse';
export type { TraverseFrame, ScanJsonOptions } from '../internal/traverse';
export { parseDeepSearchPath, deepArrayMatch, deepArrayIterator } from '../internal/deep-search';
export type { DeepSearchPath } from '../internal/deep-search';
