/**
 * Shared pieces of the flat-array fast paths (pipeline + host commit): result types/constants and
 * intent collection (operators run against a spy to learn criteria/actions without touching data),
 * eligibility (a flat scan is only valid when no nested descendant could also match the criteria)
 * and the per-item matcher.
 */
import type { Action } from '../types/actions';
import type { CompiledCriterion, SearchOptions } from '../types/model';
import { DEFAULT_MAX_DEPTH, resolveTraversal } from '../run-options';
import { criteriaMatch, type StrictOperatorContext } from '../../core/match';
import { compileCriteriaPredicate, type CompiledPredicate } from '../../core/compiled-predicate';

export interface PipelineIntent {
  criteria: CompiledCriterion[];
  actions: Action[];
  /** True when any operator tried to set pipeline options (limit/immutable/...). */
  optionsTouched: boolean;
}

export interface FastMutationResult<TData = unknown> {
  value: TData;
  /** Number of value-action applications (matched items × actions). */
  mutations: number;
  /** Number of items that matched the criteria. */
  matched: number;
  /** Changed paths relative to the branch, or null for non-precise shapes. */
  affectedPaths: string[] | null;
}

export interface FastMutationOptions {
  /**
   * Keep exact changed paths for precise host wakeups. Disable when the caller
   * only commits the returned value; this avoids one result object per match.
   */
  collectAffectedPaths?: boolean;
}

/** Matches JsnqPipeline's constructor defaults (keep in sync with core/pipeline.ts). */
export const FASTPATH_OPTIONS: Readonly<SearchOptions> = {
  maxDepth: 10,
  includeArrays: true,
  includeObjects: true,
  trackOperations: false, // host-commit fast path never inspects operation labels
};

/** Minimal pipeline-shaped spy: operators are applied to it to learn the compiled criteria/actions. */
class IntentCollector {
  criteria: CompiledCriterion[] = [];
  actions: Action[] = [];
  optionsTouched = false;

  with(next: { criteria?: CompiledCriterion[]; actions?: Action[]; options?: unknown }): IntentCollector {
    const out = new IntentCollector();
    out.criteria = next.criteria ?? this.criteria;
    out.actions = next.actions ?? this.actions;
    out.optionsTouched = this.optionsTouched || next.options !== undefined;
    return out;
  }
}

type IntentOperator = (pipeline: IntentCollector) => IntentCollector;

const unsupported = (): PipelineIntent => ({ criteria: [], actions: [], optionsTouched: true });

export function collectPipelineIntent(ops: ReadonlyArray<unknown>): PipelineIntent {
  let collector = new IntentCollector();
  if (ops && ops.length > 0) {
    try {
      for (const op of ops) {
        if (typeof op !== 'function') return unsupported();
        collector = (op as IntentOperator)(collector);
      }
    } catch {
      return unsupported();
    }
  }
  return {
    criteria: Array.isArray(collector.criteria) ? collector.criteria : [],
    actions: Array.isArray(collector.actions) ? collector.actions : [],
    optionsTouched: collector.optionsTouched,
  };
}

const hasOwn = Object.prototype.hasOwnProperty;

interface Probe {
  /** Distinct first segments of the criteria (object heads are tested with `in`). */
  heads: string[];
  /** Smallest valid array-index head; an array with more items than this can match. */
  minIndex: number;
  maxDepth: number; includeArrays: boolean; includeObjects: boolean;
}

/** True when `container` (a depth>=2 node) could satisfy some criterion head. */
function canMatchHead(container: object, probe: Probe): boolean {
  if (Array.isArray(container)) return container.length > probe.minIndex;
  const heads = probe.heads;
  for (let i = 0; i < heads.length; i++) if (heads[i]! in container) return true;
  return false;
}

/** Walks the container children of `node` (at `depth`); true as soon as one can match. `hasOwn` only runs for containers, so the common flat row pays a bare `for…in` + `typeof`. */
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
 * True when any nested descendant (beyond the top-level items) could match the criteria heads: the
 * signal that a flat scan would diverge from full DFS. Shared by both fast paths so they bail out
 * identically.
 */
export function hasNestedCriterionCandidate(items: unknown[], criteria: ReadonlyArray<CompiledCriterion>, options: Readonly<SearchOptions>): boolean {
  const { maxDepth, includeArrays, includeObjects } = resolveTraversal(options);
  if (maxDepth <= 1) return false;

  const heads: string[] = [];
  let minIndex = Infinity;
  for (const criterion of criteria) {
    const head = criterion.segments[0];
    if (head === undefined) return true;
    if (heads.indexOf(head) < 0) heads.push(head);
    // Every array has a `length`, so a `length` head makes any nested array a candidate.
    const index = head === 'length' ? -1 : Number(head) >= 0 ? Number(head) : Infinity;
    if (index < minIndex) minIndex = index;
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
  return criteria.length !== 0 && options.includeArrays !== false && (options.maxDepth ?? DEFAULT_MAX_DEPTH) >= 1 && !criteria.some((c) => c.isDeep);
}

/** Shared guard chain of both flat fast paths: root array, usable criteria/options and no nested candidate (callers check their action shape first: cheaper). */
export function isFlatScanEligible(data: unknown, criteria: ReadonlyArray<CompiledCriterion>, options: Readonly<SearchOptions>): data is unknown[] {
  return Array.isArray(data) && isFlatScanShape(criteria, options) && !hasNestedCriterionCandidate(data, criteria, options);
}

/** Codegen predicate for `criteria`, else an interpreter closure; results are identical. */
export function flatMatcher(criteria: ReadonlyArray<CompiledCriterion>, options: Readonly<SearchOptions>, ctx: StrictOperatorContext): CompiledPredicate {
  return compileCriteriaPredicate(criteria) ?? ((item) => criteriaMatch(criteria, item, options, ctx));
}

/** Fresh strict-operator context (unknown-operator warnings go to `warnings`). */
export function newStrictContext(warnings: string[] = []): StrictOperatorContext {
  return { warnedUnknownOps: new Set<string>(), warnings };
}
