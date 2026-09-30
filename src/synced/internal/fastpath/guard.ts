/**
 * Shared eligibility for the flat-array fast paths (pipeline + host commit): a flat
 * scan is only valid when no nested descendant could also match the criteria.
 */
import type { CompiledCriterion, SearchOptions } from '../../core/types';
import { resolveTraversal } from '../run-options';

const hasOwn = Object.prototype.hasOwnProperty;

interface Probe {
  /** Distinct first segments of the criteria (object heads are tested with `in`). */
  heads: string[];
  /** Smallest valid array-index head; an array with more items than this can match. */
  minIndex: number;
  maxDepth: number;
  includeArrays: boolean;
  includeObjects: boolean;
}

/** True when `container` (a depth>=2 node) could satisfy some criterion head. */
function canMatchHead(container: object, probe: Probe): boolean {
  if (Array.isArray(container)) return container.length > probe.minIndex;
  const heads = probe.heads;
  for (let i = 0; i < heads.length; i++) if (heads[i]! in container) return true;
  return false;
}

/**
 * Walks the container children of `node` (at `depth`); true as soon as one can match.
 * `hasOwn` only runs for container values: primitives never matter, so the common
 * flat row pays a bare `for…in` + `typeof`.
 */
function walkChildren(node: object, depth: number, probe: Probe): boolean {
  const childDepth = depth + 1;
  const descend = childDepth < probe.maxDepth;
  if (Array.isArray(node) && probe.includeArrays) {
    for (let i = 0; i < node.length; i++) {
      const child: unknown = node[i];
      if (typeof child !== 'object' || child === null) continue;
      if (canMatchHead(child, probe) || (descend && walkChildren(child, childDepth, probe))) return true;
    }
    return false;
  }
  if (!probe.includeObjects) return false;
  const record = node as Record<string, unknown>;
  for (const key in record) {
    const child = record[key];
    if (typeof child !== 'object' || child === null || !hasOwn.call(record, key)) continue;
    if (canMatchHead(child, probe) || (descend && walkChildren(child, childDepth, probe))) return true;
  }
  return false;
}

/**
 * True when any nested descendant (beyond the top-level items) could match the
 * criteria heads — the signal that a flat scan would diverge from full DFS.
 * Shared by both fast paths so they bail out identically. Note (known, kept):
 * array `length` criterion heads are not considered.
 */
export function hasNestedCriterionCandidate(
  items: unknown[],
  criteria: ReadonlyArray<CompiledCriterion>,
  options: Readonly<SearchOptions>
): boolean {
  const { maxDepth, includeArrays, includeObjects } = resolveTraversal(options);
  if (maxDepth <= 1) return false;

  const heads: string[] = [];
  let minIndex = Infinity;
  for (const criterion of criteria) {
    const head = criterion.segments[0];
    if (head === undefined) return true;
    if (heads.indexOf(head) < 0) heads.push(head);
    const index = Number(head);
    if (index >= 0 && index < minIndex) minIndex = index;
  }

  const probe: Probe = { heads, minIndex, maxDepth, includeArrays, includeObjects };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item === 'object' && item !== null && walkChildren(item, 1, probe)) return true;
  }
  return false;
}

/** Cheap, data-independent part of the guard: usable criteria and traversal options. */
export function isFlatScanShape(criteria: ReadonlyArray<CompiledCriterion>, options: Readonly<SearchOptions>): boolean {
  return criteria.length !== 0 && options.includeArrays !== false && (options.maxDepth ?? 10) >= 1 &&
    !criteria.some((criterion) => criterion.isDeep);
}

/**
 * Shared guard chain of both flat fast paths: a root array, non-empty non-deep criteria,
 * arrays/depth allowed by `options`, and no nested descendant that could match.
 * Callers check their own action shape first (cheaper than the nested walk).
 */
export function isFlatScanEligible(
  data: unknown,
  criteria: ReadonlyArray<CompiledCriterion>,
  options: Readonly<SearchOptions>
): data is unknown[] {
  return Array.isArray(data) && isFlatScanShape(criteria, options) && !hasNestedCriterionCandidate(data, criteria, options);
}
