/** Whole-run actions applied once after matching: insert_to, move/copy fan-out and move_matches_overwrite. */
import type { ActionMap } from '../types/actions';
import type { SearchResultNode } from '../types/pipeline';
import { KIND_STAT, type RunCtx } from './context';
import { assertCanInsertIntoTargetPath, assignWithPolicy, canInsertIntoResolvedTarget, canRemoveFromOriginal, fanoutMatchesToTargets, getAssignmentEffect, insertIntoTargetPath, orderMatchesForMove, removeFromOriginal, selectTargets, wouldCreateMoveCycle } from '../../core/ops';
import { cloneJson, hasPath, isRecordObject, resolveTargetWithPathCreation } from '../../core/utils';

export function applyInsertTo({ data: root, options, stats }: RunCtx, _matches: SearchResultNode[], action: ActionMap['insert_to']): void {
  const { position, data, mode, key } = action;
  const validatedTarget = assertCanInsertIntoTargetPath(root, position, mode, key);
  if (!canInsertIntoResolvedTarget(validatedTarget, data, mode, key, options)) {
    if (options.warnOnOverwrite !== false) {
      const target = typeof key === 'string' || typeof key === 'number' ? `${position}.${key}` : position;
      stats.warnings.push(`insert_to: target '${target}' write skipped by overwrite policy`);
    }
    return;
  }
  if (options.strictPathsWarn && !hasPath(root, position)) {
    stats.warnings.push(`insert_to: target path '${position}' did not exist; created implicitly`);
  }
  if (!options.dryRun) insertIntoTargetPath(root, position, data, mode, resolveTargetWithPathCreation, key, options, stats);
  stats.inserted++;
  if (options.trackOperations !== false) {
    stats.operations.push(`insert_to ${position} ${mode ?? 'inside'} ${typeof key === 'number' ? `index=${key}` : (key ?? '')}`);
  }
}

type FanoutAction = ActionMap['move_matches' | 'copy_matches' | 'move_first_to_matches' | 'copy_first_to_matches'];

/** move/copy every match into the first target (`allTargets` false) or into every selected target. */
export function fanoutApplier(kind: 'move' | 'copy', allTargets: boolean) {
  return ({ data, options, stats }: RunCtx, matches: SearchResultNode[], action: FanoutAction): void => {
    if (matches.length === 0) return;
    const { targetKey, targetOperator, targetValue, mode, key } = action;
    const found = selectTargets(data, options, targetKey, targetOperator, targetValue, (mode ?? 'inside') !== 'inside');
    const targets = allTargets ? found : (found.length ? [found[0]] : []);
    const applied = fanoutMatchesToTargets(kind, matches, targets, mode, key, options, stats, !!options.dryRun);
    stats[KIND_STAT[kind]] += applied;
    if (options.trackOperations !== false) {
      stats.operations.push(
        allTargets
          ? `${action.type} -> ${targets.length} targets`
          : `${action.type} -> first target (${targets[0]?.path?.join('.') ?? 'none'})`
      );
    }
  };
}

/** Result node whose data is a plain object (a valid overwrite target). */
const isRecordTarget = (node: SearchResultNode): node is SearchResultNode<Record<string, unknown>> => isRecordObject(node.data);

const overwriteError = (conflictKey: string): Error => new Error(`copy/move overwrite prevented for key '${conflictKey}'`);

export function applyMoveMatchesOverwrite({ data, options, stats }: RunCtx, matches: SearchResultNode[], action: ActionMap['move_matches_overwrite']): void {
  if (matches.length === 0) return;
  const { targetKey, targetOperator, targetValue, overwriteKey } = action;
  const targets = selectTargets(data, options, targetKey, targetOperator, targetValue, false);
  const objectTargets = targets.filter(isRecordTarget);
  for (const src of orderMatchesForMove(matches)) {
    if (!canRemoveFromOriginal(src)) {
      stats.warnings.push('move_matches_overwrite: source is not attached to a removable parent; source left in place');
      continue;
    }
    const writableTargets = objectTargets.filter((target) => {
      if (wouldCreateMoveCycle(src.data, target, 'inside')) return false;
      const targetData = target.data;
      const exists = overwriteKey in targetData;
      const effect = getAssignmentEffect(targetData, overwriteKey, options, overwriteError);
      if (effect === 'skip' && options.warnOnOverwrite !== false && exists) stats.warnings.push(`overwrite at key '${overwriteKey}'`);
      return effect === 'write';
    });
    if (writableTargets.length === 0) {
      stats.warnings.push('move_matches_overwrite: no writable object targets; source left in place');
      continue;
    }
    if (!options.dryRun) {
      if (!removeFromOriginal(src)) throw new Error('move_matches_overwrite: source changed before it could be removed');
      for (let i = 0; i < writableTargets.length; i++) {
        assignWithPolicy(writableTargets[i].data, overwriteKey, i === 0 ? src.data : cloneJson(src.data), options, stats, overwriteError);
      }
    }
    stats.moved++;
    if (options.trackOperations !== false) stats.operations.push(`move_matches_overwrite -> ${overwriteKey}`);
  }
}
