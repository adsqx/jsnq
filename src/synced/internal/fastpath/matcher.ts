/** Per-item criteria matcher shared by every flat scan (codegen when possible, interpreter otherwise). */
import type { CompiledCriterion, SearchOptions } from '../../core/types';
import { criteriaMatch } from '../../core/match';
import type { StrictOperatorContext } from '../../core/match';
import { compileCriteriaPredicate } from '../../core/compiled-predicate';
import type { CompiledPredicate } from '../../core/compiled-predicate';

/** Codegen predicate for `criteria`, else an interpreter closure; results are identical. */
export function flatMatcher(
  criteria: ReadonlyArray<CompiledCriterion>,
  options: Readonly<SearchOptions>,
  ctx: StrictOperatorContext
): CompiledPredicate {
  return compileCriteriaPredicate(criteria) ?? ((item) => criteriaMatch(criteria, item, options, ctx));
}

/** Fresh strict-operator context (unknown-operator warnings go to `warnings`). */
export function newStrictContext(warnings: string[] = []): StrictOperatorContext {
  return { warnedUnknownOps: new Set<string>(), warnings };
}
