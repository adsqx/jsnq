/** Target resolution for move/copy/insert: walk a path from a root, optionally creating missing containers. */
import { isNumericSegment, isObject } from './guards';
import { splitPath } from './path-facade';

export interface ResolvedTargetPath {
  targetNode: unknown;
  targetParent: unknown;
  targetKey?: string | number;
}

/**
 * Walk `path` from `root` and return the node, its parent and the final key.
 * With `create=true` missing object segments are created ({} or [] when the
 * next segment is numeric) and a missing array index stops the walk (so the
 * parent array + index are returned for relative inserts). With `create=false`
 * nothing is attached: missing segments resolve to a simulated empty node so
 * callers can validate the target shape without mutating the tree.
 */
export function resolveTargetPath(root: unknown, path: string, create: boolean): ResolvedTargetPath {
  const parts = splitPath(path);
  let parent: unknown = null;
  let node: unknown = root;
  let key: string | number | undefined;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    parent = node;
    if (isNumericSegment(part)) {
      key = Number(part);
      // Numeric segments address array slots only.
      if (!Array.isArray(parent)) return { targetNode: undefined, targetParent: parent, targetKey: key };
      const exists = key in parent;
      node = parent[key];
      if (create && !exists) break;
      continue;
    }
    key = part;
    if (!isObject(parent)) return { targetNode: undefined, targetParent: parent, targetKey: key };
    if (Object.prototype.hasOwnProperty.call(parent, key)) {
      node = parent[key];
      continue;
    }
    const next = isNumericSegment(parts[i + 1]) ? [] : {};
    if (create) parent[key] = next;
    node = next;
  }
  return { targetNode: node, targetParent: parent, targetKey: key };
}

export function resolveTargetWithPathCreation(root: unknown, path: string): ResolvedTargetPath {
  return resolveTargetPath(root, path, true);
}
