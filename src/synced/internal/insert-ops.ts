/** Insert preflight (`can*`) and apply (`insert*`) pairs for inside/before/after; kept separate on purpose: their edge behavior differs subtly. */
import type { InsertPosition } from './types/actions';
import type { SearchOptions, SearchResultNode } from './types/model';
import { isRecordObject, spliceClamped } from './guards';
import { assignKeyOrPath, canAssignKeyOrPath, canInsertKeyed, insertKeyed } from './assign-policy';
import { deepMerge, resolveTargetPath, type ResolvedTargetPath } from './tree-utils';

const KEY_REQUIRED_INSIDE = "insert_to/moveTo/copyTo: explicit string 'key' is required when inserting into an object target (inside)";
const KEY_REQUIRED_RELATIVE = "insert_to/moveTo/copyTo: explicit string 'key' is required when inserting before/after an object key";

/** Offset from a reference index: `before` lands on it, everything else just after it. */
const relativeOffset = (position: InsertPosition): 0 | 1 => (position === 'before' ? 0 : 1);

/** The object that receives a keyed insert: the target itself (inside) or its parent (before/after). */
export function objectContainerFor(target: SearchResultNode, position: InsertPosition): Record<string, unknown> | undefined {
  const container = position === 'inside' ? target.data : target.parent;
  return isRecordObject(container) ? container : undefined;
}

/** Numeric `key` splices (clamped) into the array, anything else appends. */
function insertIntoArray(arr: unknown[], key: string | number | undefined, data: unknown): void {
  if (typeof key === 'number') spliceClamped(arr, key, data);
  else arr.push(data);
}

export function assertCanInsertIntoTargetPath(root: unknown, positionPath: string, mode: InsertPosition = 'inside', key?: string | number): ResolvedTargetPath {
  const resolved = resolveTargetPath(root, positionPath, false);
  const { targetNode, targetParent } = resolved;

  if ((mode ?? 'inside') === 'inside') {
    if (Array.isArray(targetNode)) return resolved;
    if (!isRecordObject(targetNode)) throw new Error(`insert_to/moveTo/copyTo: target path '${positionPath}' is not insertable`);
    if (typeof key !== 'string') throw new Error(KEY_REQUIRED_INSIDE);
    return resolved;
  }

  if (Array.isArray(targetParent)) return resolved;
  if (!isRecordObject(targetParent)) throw new Error(`insert_to/moveTo/copyTo: target path '${positionPath}' has no insertable parent`);
  if (typeof key !== 'string') throw new Error(KEY_REQUIRED_RELATIVE);
  return resolved;
}

/** Preflight overwrite policy and relative-target availability before source removal. */
export function canInsertIntoResolvedTarget(resolved: ResolvedTargetPath, data: unknown, mode: InsertPosition = 'inside', key?: string | number, options?: SearchOptions): boolean {
  const { targetNode, targetParent, targetKey } = resolved;
  if (mode === 'inside') {
    if (Array.isArray(targetNode)) return true;
    return isRecordObject(targetNode) && typeof key === 'string' && canInsertKeyed(targetNode, key, options);
  }
  if (Array.isArray(targetParent)) {
    if (typeof targetKey === 'number' && (targetNode === undefined || targetNode === null)) return true;
    return targetParent.indexOf(targetNode) >= 0;
  }
  return isRecordObject(targetParent) && typeof targetKey === 'string' && typeof key === 'string'
    ? canAssignKeyOrPath(targetParent, key, options)
    : false;
}

/** Insert data relative to a reference node (inside/before/after). */
export function insertRelative(ref: SearchResultNode, data: unknown, position: InsertPosition = 'inside', key?: string | number, options?: SearchOptions, stats?: { warnings: string[] }): boolean {
  if (!ref) return false;
  if (position === 'inside') {
    const container = ref.data;
    if (Array.isArray(container)) {
      insertIntoArray(container, key, data);
      return true;
    }
    if (!isRecordObject(container)) return false;
    // INSIDE on object: explicit string key (dotted paths and existing arrays supported) ->
    // keyed insert; no key + object payload -> merge into the target (no auto key);
    // no key + non-object payload -> skipped with a warning (cannot infer a key).
    if (typeof key === 'string') return insertKeyed(container, key, data, options, stats);
    if (isRecordObject(data)) {
      // Merge in place, preserving the container reference.
      const merged = deepMerge(container, data, { arrayStrategy: options?.arrayMergeStrategy, arrayKey: options?.arrayMergeKey });
      for (const k of Object.keys(container)) delete container[k];
      Object.assign(container, merged);
      return true;
    }
    stats?.warnings.push('insert inside object without key ignored for non-object payload');
    return false;
  }
  const parent = ref.parent;
  if (!parent) return false;
  if (Array.isArray(parent)) {
    // Always indexOf: parentKey may be stale after a previous removeFromOriginal.
    const index = parent.indexOf(ref.data);
    if (index === -1) return false;
    parent.splice(index + relativeOffset(position), 0, data);
    return true;
  }
  if (!isRecordObject(parent)) return false;
  // Relative to an object key: require an explicit key, never auto-generate one.
  if (options?.objectOrderWarning !== false) {
    stats?.warnings.push('before/after on object: property order is not semantically stable in JS');
  }
  if (typeof key !== 'string' || key.length === 0) {
    stats?.warnings.push('before/after on object requires explicit string key; operation skipped');
    return false;
  }
  return assignKeyOrPath(parent, key, data, options, stats);
}

export function canInsertRelative(ref: SearchResultNode, data: unknown, position: InsertPosition = 'inside', key?: string | number, options?: SearchOptions): boolean {
  if (!ref) return false;
  if (position === 'inside') {
    if (Array.isArray(ref.data)) return true;
    if (!isRecordObject(ref.data)) return false;
    return typeof key === 'string' ? canInsertKeyed(ref.data, key, options) : isRecordObject(data);
  }
  const parent = ref.parent;
  if (!parent) return false;
  if (Array.isArray(parent)) return parent.indexOf(ref.data) !== -1;
  return isRecordObject(parent) && typeof key === 'string' && key.length > 0 && canAssignKeyOrPath(parent, key, options);
}

/** Insert `data` into a target path on the root (inside/before/after); the pipeline's move/copy/insert_to insertion. */
export function insertIntoTargetPath(
  root: unknown, positionPath: string, data: unknown, mode: InsertPosition = 'inside',
  resolver: (root: unknown, path: string) => ResolvedTargetPath,
  key?: string | number, options?: SearchOptions, stats?: { warnings: string[] }
): void {
  const { targetNode, targetParent, targetKey } = resolver(root, positionPath);
  const pos: InsertPosition = mode ?? 'inside';
  if (pos === 'inside') {
    if (Array.isArray(targetNode)) {
      insertIntoArray(targetNode, key, data);
    } else if (isRecordObject(targetNode)) {
      if (typeof key !== 'string') throw new Error(KEY_REQUIRED_INSIDE);
      insertKeyed(targetNode, key, data, options, stats);
    }
    return;
  }
  if (!targetParent) return;
  if (Array.isArray(targetParent)) {
    if (typeof targetKey === 'number' && (targetNode === undefined || targetNode === null)) {
      targetParent.splice(Math.max(0, targetKey) + relativeOffset(pos), 0, data);
    } else {
      const index = targetParent.indexOf(targetNode);
      if (index !== -1) targetParent.splice(index + relativeOffset(pos), 0, data);
    }
  } else if (isRecordObject(targetParent) && typeof targetKey === 'string') {
    if (typeof key !== 'string') throw new Error(KEY_REQUIRED_RELATIVE);
    // Object-key insert always assigns (no array push), matching the historical behavior.
    assignKeyOrPath(targetParent, key, data, options, stats);
  }
}
