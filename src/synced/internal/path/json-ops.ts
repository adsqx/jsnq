import { isForbiddenSegment, isNumericSegment, isObjectLike } from '../guards';
import { createExactSetResult, createMutationResult, getJsonAffectedPaths } from './mutation-result';
import { toPlan } from './plan-cache';
import type { JsonContainer, JsonMutationResult, JsonPathPlan, JsonResolvedParent } from './types';

const hasOwn = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

export function getJsonBySegments<T = unknown>(obj: unknown, segments: readonly string[]): T | undefined {
  // Indexed loop (not for...of) — avoids per-call iterator allocation on this hot path
  // (~10-15% on the dominant object/nested segment walk). Array string-index stays as-is:
  // a numeric-conversion variant was measured slower for objects (megamorphic key access).
  let current: unknown = obj;
  const len = segments.length;
  for (let i = 0; i < len; i++) {
    if (current == null) return undefined;
    const segment = segments[i]!;
    // Prototype guard. Path-based entry points reject these while compiling the plan, but
    // this one takes raw segments, so without the check `['__proto__']` handed back
    // Object.prototype to the caller. The length test is a cheap pre-filter: the three
    // forbidden names are 9 or 11 characters, so ordinary keys never reach the Set lookup.
    if (isForbiddenSegment(segment)) return undefined;
    current = (current as JsonContainer)[segment];
  }
  return current as T | undefined;
}

export function readJsonPath<T = unknown>(root: unknown, pathOrPlan: string | JsonPathPlan): T | undefined {
  const { segments } = toPlan(pathOrPlan);
  return segments.length === 0 ? root as T : getJsonBySegments<T>(root, segments);
}

export function hasJsonPath(root: unknown, pathOrPlan: string | JsonPathPlan): boolean {
  const { segments } = toPlan(pathOrPlan);
  let current: unknown = root;
  for (let i = 0; i < segments.length; i++) {
    if (current == null) return false;
    const segment = segments[i]!;
    if (Array.isArray(current) && isNumericSegment(segment)) {
      const index = Number(segment);
      if (index < 0 || index >= current.length) return false;
      current = current[index];
    } else {
      if (!hasOwn(current as JsonContainer, segment)) return false;
      current = (current as JsonContainer)[segment];
    }
  }
  return true;
}

/** The child of `parent` at `segment` when it is a container of the shape the next hop needs. */
export function getChild(parent: JsonContainer, segment: string, nextIsIndex: boolean): JsonContainer | undefined {
  const existing = parent[segment];
  return isObjectLike(existing) && (!nextIsIndex || Array.isArray(existing)) ? existing : undefined;
}

/** {@link getChild}, creating (or replacing a wrongly shaped) child as `[]` / `{}` when missing. */
export function ensureChild(parent: JsonContainer, segment: string, nextIsIndex: boolean): JsonContainer {
  const existing = getChild(parent, segment, nextIsIndex);
  if (existing !== undefined) return existing;
  parent[segment] = nextIsIndex ? [] : {};
  return parent[segment] as JsonContainer;
}

/** Array-aware assignment: numeric keys on arrays use the numeric index. */
export function assignJsonValue(parent: JsonContainer, key: string, value: unknown): void {
  if (Array.isArray(parent) && isNumericSegment(key)) parent[Number(key)] = value;
  else parent[key] = value;
}

/** Walks `plan.parentSegments`; undefined when a hop is missing (and `create` is off) or not traversable. */
function walkParents(root: unknown, plan: JsonPathPlan, create: boolean): unknown {
  const { parentSegments, nextIsIndex } = plan;
  let parent: unknown = root;
  for (let i = 0; i < parentSegments.length; i++) {
    if (!isObjectLike(parent)) return undefined;
    parent = create ? ensureChild(parent, parentSegments[i]!, !!nextIsIndex[i]) : getChild(parent, parentSegments[i]!, !!nextIsIndex[i]);
  }
  return parent;
}

export function resolveJsonParentAndKey(
  root: unknown,
  pathOrPlan: string | JsonPathPlan,
  options: { create?: boolean } = {}
): JsonResolvedParent {
  const plan = toPlan(pathOrPlan);
  if (plan.segments.length === 0) return { parent: root, key: null, segments: plan.segments };
  return { parent: walkParents(root, plan, !!options.create), key: plan.key, segments: plan.segments };
}

/** Assigns `value` at `key` of `parent` and reports it as an exact-path set. */
export function setAt(parent: JsonContainer, plan: JsonPathPlan, key: string, value: unknown): JsonMutationResult {
  const existed = hasOwn(parent, key);
  const previous = parent[key];
  assignJsonValue(parent, key, value);
  return createExactSetResult(plan, previous, value, existed, isObjectLike(previous) || isObjectLike(value));
}

export function writeJsonPath(root: unknown, pathOrPlan: string | JsonPathPlan, value: unknown): JsonMutationResult {
  const plan = toPlan(pathOrPlan);
  const key = plan.key;
  if (key == null) return createExactSetResult(plan, root, value, true, isObjectLike(root) || isObjectLike(value));
  const parent = walkParents(root, plan, true);
  if (!isObjectLike(parent)) return createMutationResult({ path: plan, kind: 'set', next: value, parents: [], affectedPaths: [] });
  return setAt(parent, plan, key, value);
}

/**
 * Write-only variant for hosts that perform their own wake bookkeeping. It uses
 * the same cached path plan and parent walk as `writeJsonPath`, but avoids
 * allocating a mutation-result object and path arrays that the caller would discard.
 * Returns false for a root path or an unresolvable target.
 */
export function writeJsonPathValue(root: unknown, pathOrPlan: string | JsonPathPlan, value: unknown): boolean {
  const plan = toPlan(pathOrPlan);
  const key = plan.key;
  if (key == null) return false;
  const parent = walkParents(root, plan, true);
  if (!isObjectLike(parent)) return false;
  assignJsonValue(parent, key, value);
  return true;
}

export function deleteJsonPath(root: unknown, pathOrPlan: string | JsonPathPlan): JsonMutationResult {
  const plan = toPlan(pathOrPlan);
  const key = plan.key;
  if (key == null) {
    const exact = getJsonAffectedPaths(plan, 'exact');
    return createMutationResult({
      path: plan, kind: 'delete', previous: root, existed: true, deleted: exact,
      branchReplaced: isObjectLike(root), affectedPaths: exact,
    });
  }
  const parent = walkParents(root, plan, false);
  if (!isObjectLike(parent)) return createMutationResult({ path: plan, kind: 'delete', parents: [], affectedPaths: [] });
  const existed = hasOwn(parent, key);
  const previous = parent[key];
  if (Array.isArray(parent) && isNumericSegment(key)) {
    const index = Number(key);
    if (index >= 0 && index < parent.length) parent.splice(index, 1);
  } else {
    delete parent[key];
  }
  return createMutationResult({
    path: plan, kind: 'delete', previous, existed,
    deleted: existed ? getJsonAffectedPaths(plan, 'exact') : [],
    branchReplaced: existed && isObjectLike(previous),
    affectedPaths: getJsonAffectedPaths(plan, 'branch'),
  });
}
