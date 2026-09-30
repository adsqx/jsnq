/** Per-match structural actions (applied to each result node): delete_element, insert, move, copy. */
import type { ActionMap } from '../types/actions';
import type { SearchResultNode } from '../types/pipeline';
import { KIND_STAT, type RunCtx } from './context';
import { assertCanInsertIntoTargetPath, canInsertIntoResolvedTarget, canInsertRelative, canRemoveFromOriginal, insertIntoTargetPath, insertRelative, removeFromOriginal, wouldCreateMoveCycleAtPath } from '../../core/ops';
import { cloneJson, hasPath, resolveTargetWithPathCreation } from '../../core/utils';

const keyLabel = (key: string | number | undefined): string => (typeof key === 'number' ? `index=${key}` : (key ?? ''));

export function applyDeleteElement({ options, stats }: RunCtx, node: SearchResultNode): void {
  if (!options.dryRun) removeFromOriginal(node);
  stats.deletedElements++;
  if (options.trackOperations !== false) stats.operations.push(`delete_element at ${node.path?.join('.') ?? '<unknown>'}`);
}

export function applyInsert({ options, stats }: RunCtx, node: SearchResultNode, { data, position, key }: ActionMap['insert']): void {
  if (!canInsertRelative(node, data, position, key, options)) {
    if (options.warnOnOverwrite !== false) {
      const target = typeof key === 'string' || typeof key === 'number' ? ` '${key}'` : '';
      stats.warnings.push(`insert: target${target} is not writable; operation skipped`);
    }
    return;
  }
  if (!options.dryRun && !insertRelative(node, data, position, key, options, stats)) return;
  stats.inserted++;
  if (options.trackOperations !== false) stats.operations.push(`insert ${position} ${keyLabel(key)}`);
}

/** move/copy share one insertion contract (validated before clone, removal, path creation or stats). */
export function applyMoveOrCopy(ctx: RunCtx, node: SearchResultNode, { position, mode, key }: ActionMap['move' | 'copy'], kind: 'move' | 'copy'): void {
  const { data, options, stats } = ctx;
  const isCopy = kind === 'copy';
  const validatedTarget = assertCanInsertIntoTargetPath(data, position, mode, key);
  if (!canInsertIntoResolvedTarget(validatedTarget, node.data, mode, key, options)) {
    if (options.warnOnOverwrite !== false) stats.warnings.push(`${kind}: target write skipped by overwrite policy`);
    return;
  }
  if (!isCopy) {
    if (!canRemoveFromOriginal(node)) throw new Error('move: source is not attached to a removable parent');
    if (wouldCreateMoveCycleAtPath(data, node.data, position)) {
      throw new Error(`move: target path '${position}' is the source or one of its descendants`);
    }
  }
  if (!options.dryRun) {
    if (options.strictPathsWarn && !hasPath(data, position)) {
      stats.warnings.push(`${kind}: target path '${position}' did not exist; created implicitly`);
    }
    const element = isCopy ? cloneJson(node.data) : node.data;
    const plannedTarget = resolveTargetWithPathCreation(data, position);
    if (!isCopy && !removeFromOriginal(node)) throw new Error('move: source changed before it could be removed');
    // insertIntoTargetPath inserts INTO the target (never replaces it), so the pre-resolved
    // target stays valid for both move and copy (no second O(depth) resolve from the root).
    insertIntoTargetPath(data, position, element, mode, () => plannedTarget, key, options, stats);
  }
  stats[KIND_STAT[kind]]++;
  if (options.trackOperations !== false) stats.operations.push(`${kind} -> ${position}`);
}
