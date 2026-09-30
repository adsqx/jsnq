/** One-time analysis of a pipeline's criteria per execute(): shape flags plus the chosen matcher. */
import type { CompiledCriterion } from '../types/operators';
import type { SearchOptions } from '../types/options';
import { compileCriteriaPredicate, type CompiledPredicate } from '../../core/compiled-predicate';
import { criteriaMatch, enforceKnownOperator, type StrictOperatorContext } from '../../core/match';

export interface CriteriaPlan {
  /** Some criterion is a deep `@` path. */
  hasDeep: boolean;
  /** Some deep criterion descends into array elements (needs the sequential matcher). */
  hasDeepArray: boolean;
  /** Node matcher: always-true for no criteria, else the codegen predicate, else the interpreter. */
  match: CompiledPredicate;
}

const MATCH_ALL: CompiledPredicate = () => true;

/**
 * Enforces the strict-operator policy once (instead of once per visited node) and picks the matcher.
 * After this the compiled predicate can safely replace the interpreter without losing
 * warnings / throw semantics.
 */
export function planCriteria(criteria: ReadonlyArray<CompiledCriterion>, options: Readonly<SearchOptions>, ctx: StrictOperatorContext): CriteriaPlan {
  let hasDeep = false;
  let hasDeepArray = false;
  for (const c of criteria) {
    enforceKnownOperator(c, options, ctx);
    if (c.isDeep) {
      hasDeep = true;
      if (c.deepArrayKey) hasDeepArray = true;
    }
  }
  // The codegen predicate covers shallow, single-segment, built-in-operator criteria (null otherwise,
  // e.g. deep/custom-op criteria or a strict CSP); it mirrors the interpreter exactly.
  const pred = hasDeep ? null : compileCriteriaPredicate(criteria);
  const match = criteria.length === 0 ? MATCH_ALL : pred ?? ((node: unknown) => criteriaMatch(criteria, node, options, ctx));
  return { hasDeep, hasDeepArray, match };
}
