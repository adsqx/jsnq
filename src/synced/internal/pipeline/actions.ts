/**
 * Appliers for every action phase. Value actions (replace / update / merge_update / delete_key) work
 * on a PreparedAction (key compiled to a JsonPathPlan up front; single-segment keys take a direct
 * property access); their counter bump and operation label are shared post-steps of core/actions.
 * Node actions (per match: delete_element, insert, move, copy) and global actions (once per run:
 * insert_to, match fan-out, move_matches_overwrite) only apply and log; they report what was applied
 * (node: boolean, global: count) and the caller bumps the registry's counter for the action type.
 */
import type { ActionMap, ActionType, MergeUpdateAction } from '../types/actions';
import type { PipelineStats, SearchOptions, SearchResultNode } from '../types/model';
import type { PreparedAction } from '../../core/actions';
import { deleteJsonPath, getJsonBySegments, hasJsonPath, writeJsonPath } from '../../core/data-engine';
import { ACTION_STAT, type RunCtx } from '../run-options';
import { assignWithPolicy, getAssignmentEffect } from '../assign-policy';
import { fanoutMatchesToTargets, selectTargets } from '../fanout';
import { assertCanInsertIntoTargetPath, canInsertIntoResolvedTarget, canInsertRelative, insertIntoTargetPath, insertRelative } from '../insert-ops';
import { canRemoveFromOriginal, orderMatchesForMove, removeFromOriginal, wouldCreateMoveCycle, wouldCreateMoveCycleAtPath } from '../move-ops';
import { hasOwn, isObject, isRecordObject } from '../guards';
import { cloneJson, deepMerge, hasPath, resolveTargetWithPathCreation } from '../tree-utils';

/** A PreparedAction whose `action` is narrowed to the given action type(s). */
export interface PreparedOf<K extends ActionType> extends PreparedAction { action: ActionMap[K] }

type ValueFn = (current: unknown, node: unknown) => unknown;
const isValueFn = (v: unknown): v is ValueFn => typeof v === 'function';

const isIndexable = (t: unknown): t is Record<string, unknown> => t != null;
const isPlainTarget = (t: unknown): t is Record<string, unknown> => t != null && typeof t === 'object' && !Array.isArray(t);

function readPrepared(target: unknown, prepared: PreparedAction): unknown {
  if (prepared.single !== null && isIndexable(target)) return target[prepared.single];
  return getJsonBySegments(target, prepared.plan!.segments);
}

function preparedPathExists(target: unknown, prepared: PreparedAction): boolean {
  if (prepared.single !== null) return target != null && typeof target === 'object' && hasOwn(target, prepared.single);
  return hasJsonPath(target, prepared.plan!);
}

function writePrepared(target: unknown, prepared: PreparedAction, value: unknown): void {
  if (prepared.single !== null && isPlainTarget(target)) target[prepared.single] = value;
  else writeJsonPath(target, prepared.plan!, value);
}

function deletePrepared(target: unknown, prepared: PreparedAction): void {
  if (prepared.single !== null && isPlainTarget(target)) delete target[prepared.single];
  else deleteJsonPath(target, prepared.plan!);
}

export function computeMergedValue(current: unknown, action: MergeUpdateAction, options: Readonly<SearchOptions>): unknown {
  if (!isObject(current) || !isObject(action.patch)) return action.patch;
  if (action.deep === true) {
    return deepMerge(current, action.patch, { arrayStrategy: options.arrayMergeStrategy, arrayKey: options.arrayMergeKey });
  }
  return { ...current, ...action.patch };
}

function warnImplicitPath(target: unknown, p: PreparedAction, options: Readonly<SearchOptions>, stats: PipelineStats, message: string): void {
  if (options.strictPathsWarn && !preparedPathExists(target, p)) stats.warnings.push(message);
}

const pathOf = (p: PreparedAction): string => p.plan?.path ?? '';

export function applyAssign(target: unknown, p: PreparedOf<'replace' | 'update'>, options: Readonly<SearchOptions>, stats: PipelineStats): void {
  const { value, type } = p.action;
  const next = isValueFn(value) ? value(readPrepared(target, p), target) : value;
  warnImplicitPath(target, p, options, stats, `${type}: path '${pathOf(p)}' did not exist; created implicitly`);
  if (!options.dryRun) writePrepared(target, p, next);
}

export function applyMerge(target: unknown, p: PreparedOf<'merge_update'>, options: Readonly<SearchOptions>, stats: PipelineStats): void {
  const merged = computeMergedValue(readPrepared(target, p), p.action, options);
  warnImplicitPath(target, p, options, stats, `merge_update: path '${pathOf(p)}' did not exist; created implicitly`);
  if (!options.dryRun) writePrepared(target, p, merged);
}

export function applyDeleteKey(target: unknown, p: PreparedOf<'delete_key'>, options: Readonly<SearchOptions>, stats: PipelineStats): void {
  warnImplicitPath(target, p, options, stats, `delete_key: path '${pathOf(p)}' did not exist`);
  if (!options.dryRun) deletePrepared(target, p);
}

/** Operation-log line of a value action (constant per action, so it is built once at prepare time). */
export function valueLabel(action: ActionMap['replace' | 'update' | 'merge_update' | 'delete_key'], path: string): string {
  return action.type === 'merge_update' ? `merge_update ${path}${action.deep === true ? ' (deep)' : ''}` : `${action.type} ${path}`;
}

// ---- node and global phases ----

const keyLabel = (key: string | number | undefined): string => (typeof key === 'number' ? `index=${key}` : (key ?? ''));

export function applyDeleteElement({ options, stats }: RunCtx, node: SearchResultNode): boolean {
  if (!options.dryRun) removeFromOriginal(node);
  if (options.trackOperations !== false) stats.operations.push(`delete_element at ${node.path?.join('.') ?? '<unknown>'}`);
  return true;
}

export function applyInsert({ options, stats }: RunCtx, node: SearchResultNode, { data, position, key }: ActionMap['insert']): boolean {
  if (!canInsertRelative(node, data, position, key, options)) {
    if (options.warnOnOverwrite !== false) {
      const target = typeof key === 'string' || typeof key === 'number' ? ` '${key}'` : '';
      stats.warnings.push(`insert: target${target} is not writable; operation skipped`);
    }
    return false;
  }
  if (!options.dryRun && !insertRelative(node, data, position, key, options, stats)) return false;
  if (options.trackOperations !== false) stats.operations.push(`insert ${position} ${keyLabel(key)}`);
  return true;
}

/** move/copy share one insertion contract (validated before clone, removal, path creation or stats). */
export function applyMoveOrCopy(ctx: RunCtx, node: SearchResultNode, { position, mode, key }: ActionMap['move' | 'copy'], kind: 'move' | 'copy'): boolean {
  const { data, options, stats } = ctx;
  const isCopy = kind === 'copy';
  const validatedTarget = assertCanInsertIntoTargetPath(data, position, mode, key);
  if (!canInsertIntoResolvedTarget(validatedTarget, node.data, mode, key, options)) {
    if (options.warnOnOverwrite !== false) stats.warnings.push(`${kind}: target write skipped by overwrite policy`);
    return false;
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
  if (options.trackOperations !== false) stats.operations.push(`${kind} -> ${position}`);
  return true;
}

export function applyInsertTo({ data: root, options, stats }: RunCtx, _matches: SearchResultNode[], action: ActionMap['insert_to']): number {
  const { position, data, mode, key } = action;
  const validatedTarget = assertCanInsertIntoTargetPath(root, position, mode, key);
  if (!canInsertIntoResolvedTarget(validatedTarget, data, mode, key, options)) {
    if (options.warnOnOverwrite !== false) {
      const target = typeof key === 'string' || typeof key === 'number' ? `${position}.${key}` : position;
      stats.warnings.push(`insert_to: target '${target}' write skipped by overwrite policy`);
    }
    return 0;
  }
  if (options.strictPathsWarn && !hasPath(root, position)) {
    stats.warnings.push(`insert_to: target path '${position}' did not exist; created implicitly`);
  }
  if (!options.dryRun) insertIntoTargetPath(root, position, data, mode, resolveTargetWithPathCreation, key, options, stats);
  if (options.trackOperations !== false) stats.operations.push(`insert_to ${position} ${mode ?? 'inside'} ${keyLabel(key)}`);
  return 1;
}

type FanoutAction = ActionMap['move_matches' | 'copy_matches' | 'move_first_to_matches' | 'copy_first_to_matches'];

/** move/copy every match into the first target (`allTargets` false) or into every selected target. */
export function fanoutApplier(kind: 'move' | 'copy', allTargets: boolean) {
  return ({ data, options, stats }: RunCtx, matches: SearchResultNode[], action: FanoutAction): number => {
    if (matches.length === 0) return 0;
    const { targetKey, targetOperator, targetValue, mode, key } = action;
    const found = selectTargets(data, options, targetKey, targetOperator, targetValue, (mode ?? 'inside') !== 'inside');
    const targets = allTargets ? found : found.slice(0, 1);
    const applied = fanoutMatchesToTargets(kind, matches, targets, mode, key, options, stats, !!options.dryRun);
    if (options.trackOperations !== false) {
      stats.operations.push(
        allTargets
          ? `${action.type} -> ${targets.length} targets`
          : `${action.type} -> first target (${targets[0]?.path?.join('.') ?? 'none'})`
      );
    }
    return applied;
  };
}

const overwriteError = (conflictKey: string): Error => new Error(`copy/move overwrite prevented for key '${conflictKey}'`);

/** Bumps its counter per moved source itself (not via the caller) so stats stay exact if a later source throws. */
export function applyMoveMatchesOverwrite({ data, options, stats }: RunCtx, matches: SearchResultNode[], action: ActionMap['move_matches_overwrite']): number {
  if (matches.length === 0) return 0;
  const { targetKey, targetOperator, targetValue, overwriteKey } = action;
  const objectTargets = selectTargets(data, options, targetKey, targetOperator, targetValue, false)
    .filter((node): node is SearchResultNode<Record<string, unknown>> => isRecordObject(node.data));
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
    stats[ACTION_STAT.move_matches_overwrite]++;
    if (options.trackOperations !== false) stats.operations.push(`move_matches_overwrite -> ${overwriteKey}`);
  }
  return 0;
}
