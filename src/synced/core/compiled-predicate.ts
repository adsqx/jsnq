import type { CompiledCriterion } from './types';
import { canCompile, criteriaCheckSource, criteriaCodegenable, criteriaSignature, makeFactoryCache, opExpr } from '../internal/codegen/common';

/**
 * Optional codegen fast path for the criteria matcher: compiles single-segment, non-deep,
 * built-in-operator criteria into ONE predicate via `new Function` (cached by signature), so the
 * JIT inlines the comparisons like a hand-written `.filter`.
 *
 * SAFETY: returns null (caller keeps the interpreter `criteriaMatch`) whenever anything is not
 * trivially codegen-able — deep `@`, multi-segment paths, regex / custom operators, an empty
 * segment, or a blocked `new Function` (strict CSP). The generated code mirrors criterionMatches
 * + the built-in operator table EXACTLY; the fastpath-parity / edge / vs-native suites guard that.
 */

export type CompiledPredicate = (data: unknown) => boolean;

type Factory = (vals: unknown[]) => CompiledPredicate;
const factories = makeFactoryCache<Factory>(2000);
export function setCompiledPredicateCacheLimit(limit: number): void { factories.setLimit(limit); }
export function clearCompiledPredicateCache(): void { factories.clear(); }

// Boolean source expression for an operator (value-var `a`, criterion-value ref `b`); null for non-codegen ops.
export { opExpr };

function buildFactory(criteria: ReadonlyArray<CompiledCriterion>): Factory | null {
  const lines = [`if (it === null || typeof it !== 'object') return false;`, ...criteriaCheckSource(criteria, 'return false')];
  lines.push(`return true;`);
  try {
    return new Function('vals', `return function(it){\n${lines.join('\n')}\n};`) as Factory;
  } catch {
    return null;
  }
}

/** Compiled predicate for `criteria`, or null when the interpreter must be used (factory cached by signature, bound to the current values per call). */
export function compileCriteriaPredicate(criteria: ReadonlyArray<CompiledCriterion>): CompiledPredicate | null {
  if (!canCompile() || !criteriaCodegenable(criteria)) return null;
  const factory = factories.getOrBuild(criteriaSignature(criteria), () => buildFactory(criteria));
  return factory ? factory(criteria.map((c) => c.value)) : null;
}
