/**
 * Appliers for the "value" actions (replace / update / merge_update / delete_key). Each works on a
 * PreparedAction whose key was compiled to a JsonPathPlan up front, so per-node application never
 * re-parses paths and single-segment keys take a direct property access.
 * The stat bump and operation label are shared post-steps of the caller (see core/actions.ts).
 */
import type { ActionMap, ActionType, MergeUpdateAction } from '../types/actions';
import type { SearchOptions } from '../types/options';
import type { PipelineStats } from '../types/stats';
import type { PreparedAction } from '../../core/actions';
import { deleteJsonPath, getJsonBySegments, hasJsonPath, writeJsonPath } from '../../core/data-engine';
import { deepMerge, isObject } from '../../core/utils';

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
  if (prepared.single !== null) {
    return target != null && typeof target === 'object' && Object.prototype.hasOwnProperty.call(target, prepared.single);
  }
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
