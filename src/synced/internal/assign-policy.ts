/**
 * Overwrite-policy resolution and keyed/dotted-path assignment used by insert, move and copy.
 * Depends on core/utils for path access only (never on ops/pipeline).
 */
import type { SearchOptions } from './types/options';
import type { WarnSink } from './types/stats';
import { isForbiddenKey } from './guards';
import { hasPath, setByPath } from '../core/utils';

type MutableRecord = Record<string, unknown>;
type OverwriteEffect = 'write' | 'skip';
type ConflictHandler = (conflictKey: string, errorFactory: (conflictKey: string) => Error) => OverwriteEffect;

/** What an overwrite conflict does, per `options.overwritePolicy`. */
const ON_CONFLICT: Record<NonNullable<SearchOptions['overwritePolicy']>, ConflictHandler> = {
  overwrite: () => 'write',
  skip: () => 'skip',
  error: (conflictKey, errorFactory) => { throw errorFactory(conflictKey); },
};

export const insertConflictError = (conflictKey: string): Error => new Error(`insert overwrite prevented for key '${conflictKey}'`);

export function resolveOverwriteEffect(
  exists: boolean,
  conflictKey: string,
  options: SearchOptions | undefined,
  errorFactory: (conflictKey: string) => Error
): OverwriteEffect {
  return exists ? ON_CONFLICT[options?.overwritePolicy ?? 'overwrite'](conflictKey, errorFactory) : 'write';
}

/** Push the standard overwrite warning unless `warnOnOverwrite` is off. */
export function warnOverwrite(options: SearchOptions | undefined, stats: WarnSink | undefined, key: string): void {
  if (options?.warnOnOverwrite !== false) stats?.warnings.push(`overwrite at key '${key}'`);
}

/** Own-or-inherited key presence; forbidden keys are rejected before any policy runs. */
function keyExists(target: MutableRecord, key: string): boolean {
  if (isForbiddenKey(key)) throw new Error(`Unsafe object key '${key}'`);
  return key in target;
}

/** Shared core: applies policy and the overwrite warning; true when the write should proceed. */
function admitWrite(
  exists: boolean,
  key: string,
  options: SearchOptions | undefined,
  stats: WarnSink | undefined,
  errorFactory: (conflictKey: string) => Error
): boolean {
  const effect = resolveOverwriteEffect(exists, key, options, errorFactory);
  if (exists) warnOverwrite(options, stats, key);
  return effect === 'write';
}

export function assignWithPolicy(
  target: MutableRecord,
  key: string | number,
  value: unknown,
  options: SearchOptions | undefined,
  stats: { warnings: string[] } | undefined,
  errorFactory: (conflictKey: string) => Error
): boolean {
  const keyStr = String(key);
  if (!admitWrite(keyExists(target, keyStr), keyStr, options, stats, errorFactory)) return false;
  target[keyStr] = value;
  return true;
}

export function getAssignmentEffect(
  target: MutableRecord,
  key: string | number,
  options: SearchOptions | undefined,
  errorFactory: (conflictKey: string) => Error
): 'write' | 'skip' {
  const keyStr = String(key);
  return resolveOverwriteEffect(keyExists(target, keyStr), keyStr, options, errorFactory);
}

/** Assign at `key` on an object target; dotted keys go through path assignment. */
export function assignKeyOrPath(
  target: MutableRecord,
  key: string,
  value: unknown,
  options: SearchOptions | undefined,
  stats: WarnSink | undefined
): boolean {
  if (!key.includes('.')) return assignWithPolicy(target, key, value, options, stats, insertConflictError);
  if (!admitWrite(hasPath(target, key), key, options, stats, insertConflictError)) return false;
  setByPath(target, key, value);
  return true;
}

/** Preflight of {@link assignKeyOrPath}: true when policy permits the write (throws for `error` policy conflicts). */
export function canAssignKeyOrPath(target: MutableRecord, key: string, options: SearchOptions | undefined): boolean {
  const exists = key.includes('.') ? hasPath(target, key) : keyExists(target, key);
  return resolveOverwriteEffect(exists, key, options, insertConflictError) === 'write';
}

/** The array stored at a plain (non-dotted) `key`, if any: inserts push into it instead of overwriting. */
export function arrayAt(container: MutableRecord, key: string): unknown[] | undefined {
  if (key.includes('.')) return undefined;
  const value = container[key];
  return Array.isArray(value) ? value : undefined;
}

/** Preflight of {@link insertKeyed}: true when it would push into an array or write the slot. */
export function canInsertKeyed(container: MutableRecord, key: string, options: SearchOptions | undefined): boolean {
  return arrayAt(container, key) !== undefined || canAssignKeyOrPath(container, key, options);
}

/** Insert under `key` of an object container: push into an existing array, else assign per policy. */
export function insertKeyed(
  container: MutableRecord,
  key: string,
  data: unknown,
  options: SearchOptions | undefined,
  stats: WarnSink | undefined
): boolean {
  const existing = arrayAt(container, key);
  if (existing) {
    existing.push(data);
    return true;
  }
  return assignKeyOrPath(container, key, data, options, stats);
}
