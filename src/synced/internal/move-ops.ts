/** Source removal, cycle detection and removal ordering for move operations. */
import type { InsertPosition } from './types/actions';
import type { SearchResultNode } from './types/model';
import { isObject, isRecordObject } from './guards';
import { splitPath, type ResolvedTargetPath } from './tree-utils';

const hasOwn = (obj: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/** Index of `node.data` in its array parent: the `parentKey` hint when still accurate, else a search (-1 if absent). */
function ownedIndex(parent: unknown[], node: SearchResultNode): number {
  const hint = node.parentKey;
  return typeof hint === 'number' && hint >= 0 && hint < parent.length && parent[hint] === node.data
    ? hint
    : parent.indexOf(node.data);
}

/**
 * True when the captured parent still owns this exact node.
 */
export function canRemoveFromOriginal(node: SearchResultNode): boolean {
  if (!node || node.parent === undefined || node.parent === null || node.parentKey === undefined) return false;
  const { parent, parentKey } = node;
  if (Array.isArray(parent)) return ownedIndex(parent, node) >= 0;
  return isRecordObject(parent) && hasOwn(parent, parentKey) && parent[parentKey] === node.data;
}

/** Remove only when the captured parent still owns this exact node. */
export function removeFromOriginal(node: SearchResultNode): boolean {
  if (!canRemoveFromOriginal(node)) return false;
  const { parent, parentKey } = node;
  if (Array.isArray(parent)) {
    // Historical quirk kept as-is: unlike canRemoveFromOriginal the hint is not range-checked here,
    // so a stale out-of-range hint on an `undefined` node is a silent no-op splice.
    const hint = typeof node.parentKey === 'number' ? node.parentKey : -1;
    parent.splice(hint >= 0 && parent[hint] === node.data ? hint : parent.indexOf(node.data), 1);
    return true;
  }
  if (!isRecordObject(parent) || parentKey === undefined) return false;
  delete parent[parentKey];
  return true;
}

function containsObjectReference(root: unknown, candidate: unknown): boolean {
  if (!isObject(root) || !isObject(candidate)) return false;
  const stack: object[] = [root];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === candidate) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const children = Array.isArray(current) ? current : Object.values(current);
    for (let i = 0; i < children.length; i++) {
      if (isObject(children[i])) stack.push(children[i]);
    }
  }
  return false;
}

/** True when inserting `source` at `target` would attach it below itself. */
export function wouldCreateMoveCycle(
  source: unknown,
  target: ResolvedTargetPath | SearchResultNode,
  mode: InsertPosition = 'inside'
): boolean {
  if (!isObject(source)) return false;
  const targetNode = 'targetNode' in target ? target.targetNode : target.data;
  const targetParent = 'targetParent' in target ? target.targetParent : target.parent;
  if (targetNode === source) return true;
  const container = mode === 'inside' ? targetNode : targetParent;
  if (containsObjectReference(source, container)) return true;
  // A missing path resolves to a detached placeholder. Its existing parent still
  // reveals whether path creation would happen below the source.
  return mode === 'inside' && containsObjectReference(source, targetParent);
}

/** O(path depth) cycle guard for moveTo(path), including aliased source branches. */
export function wouldCreateMoveCycleAtPath(root: unknown, source: unknown, positionPath: string): boolean {
  if (!isObject(source)) return false;
  const segments = splitPath(positionPath);
  let node = root;
  if (node === source) return true;
  for (const segment of segments) {
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return false;
      node = node[index];
    } else if (isRecordObject(node) && hasOwn(node, segment)) {
      node = node[segment];
    } else {
      return false;
    }
    if (node === source) return true;
  }
  return false;
}

/** Safe removal order for moves: deeper nodes first, and for arrays by descending index. */
export function orderMatchesForMove(matches: SearchResultNode[]): SearchResultNode[] {
  return [...matches].sort((a, b) => {
    if (a.parent === b.parent) {
      const ai = typeof a.parentKey === 'number' ? a.parentKey : -1;
      const bi = typeof b.parentKey === 'number' ? b.parentKey : -1;
      if (ai !== -1 || bi !== -1) return bi - ai; // remove higher indexes first
    }
    return (b.depth ?? 0) - (a.depth ?? 0);
  });
}
