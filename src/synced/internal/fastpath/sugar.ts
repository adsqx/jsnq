/** `update({patch})` / `replace({patch})` sugar: the patch object travels in the action's `key`. */
import type { Action, CompiledCriterion } from '../../core/types';
import { criteriaMatch } from '../../core/match';
import { createJsonPathPlanFromSegments } from '../../core/data-engine';
import { cloneJson, getBySegments } from '../../core/utils';
import { isObject, isRecordObject } from '../guards';
import { FASTPATH_OPTIONS } from './types';
import { newStrictContext } from './matcher';

export type SugarPatch = Record<string, unknown>;

const keyOf = (action: Action): unknown => ('key' in action ? action.key : undefined);

/** The sugar patch of a flat-array action, or null for any other action. */
export function sugarPatchOf(action: Action): SugarPatch | null {
  if (action.type !== 'update' && action.type !== 'replace') return null;
  const key = keyOf(action);
  return isRecordObject(key) ? key : null;
}

/** update({patch}) / replace({patch}) sugar on object trees (key is the patch). */
export function isDeepSugarAction(action: unknown): boolean {
  const a = action as { type?: unknown; key?: unknown } | null;
  return !!a && (a.type === 'update' || a.type === 'replace') && (typeof a.key === 'object' || a.key == null);
}

/**
 * Sugar deep update: where('deep.path.to.leaf', op, X) + update({patch}).
 * The patch is applied at the PARENT object of the leaf named by the last
 * where segment; when the leaf exists but is null/undefined the patch object
 * replaces the leaf slot itself. This form is not representable in the raw
 * pipeline (action keys must be string paths), so this helper is the
 * canonical semantics for every host. Input is never mutated.
 */
export function applyDeepSugarPatch(current: unknown, criteria: ReadonlyArray<unknown>, actions: ReadonlyArray<unknown>): unknown {
  if (!isObject(current)) return current;

  const compiledCriteria = criteria as CompiledCriterion[];
  if (!criteriaMatch(compiledCriteria, current, FASTPATH_OPTIONS, newStrictContext())) return current;

  // Clone once (deep structures in the sugar cases are small).
  const result = cloneJson(current);

  const sugarActions = (actions as Array<{ key?: unknown; value?: unknown }>).filter(isDeepSugarAction);
  if (sugarActions.length === 0) return result;

  for (const crit of compiledCriteria) {
    const segs: string[] = Array.isArray(crit?.segments) ? crit.segments : [];
    if (segs.length === 0) continue;

    // Parent path of the leaf targeted by the where (owner of the matched prop).
    const parentSegs = createJsonPathPlanFromSegments(segs).parentSegments;

    // Replace-slot only when the last segment key EXISTS on the owner in the
    // ORIGINAL data and its value is null/undefined; absent keys keep the
    // assign-at-parent behavior.
    const lastSeg = segs[segs.length - 1];
    let isNullOrUndefLeafTarget = false;
    if (lastSeg != null) {
      const owner = getBySegments(current, parentSegs);
      if (isObject(owner) && lastSeg in owner && owner[lastSeg] == null) isNullOrUndefLeafTarget = true;
    }

    // Resolve (or create) the patch target inside the clone.
    let target: Record<string, unknown> = result;
    for (const seg of parentSegs) {
      if (!isObject(target[seg])) target[seg] = {};
      target = target[seg] as Record<string, unknown>;
    }

    for (const act of sugarActions) {
      const patch = (act.key && typeof act.key === 'object') ? act.key : (act.value || {});
      if (patch && typeof patch === 'object') {
        if (lastSeg != null && isNullOrUndefLeafTarget) {
          target[lastSeg] = patch;
        } else {
          Object.assign(target, patch);
        }
      }
    }
  }

  return result;
}
