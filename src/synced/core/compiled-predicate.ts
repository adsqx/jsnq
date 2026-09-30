import type { CompiledCriterion } from './types';
import { canCompile, criteriaCodegenable, criteriaSignature, makeFactoryCache, opExpr } from '../internal/codegen/common';

/**
 * Optional codegen fast path for the criteria matcher. Compiles a set of single-segment,
 * non-deep, built-in-operator criteria into ONE predicate via `new Function` (cached by
 * signature), so the JIT inlines the comparisons like a hand-written `.filter` instead of
 * paying per-item operator indirection + the criteria loop.
 *
 * SAFETY: returns null (caller keeps the interpreter `criteriaMatch`) whenever anything is
 * not trivially codegen-able — deep `@`, multi-segment paths, regex / custom operators, an
 * empty segment, or environments where `new Function` is blocked (strict CSP). The generated
 * code mirrors criterionMatches + the built-in operator table EXACTLY; the fastpath-parity /
 * edge / vs-native suites guard that equivalence.
 */

export type CompiledPredicate = (data: unknown) => boolean;

type Factory = (vals: unknown[]) => CompiledPredicate;
const factories = makeFactoryCache<Factory>(2000);
export function setCompiledPredicateCacheLimit(limit: number): void { factories.setLimit(limit); }
export function clearCompiledPredicateCache(): void { factories.clear(); }

// Boolean expression for an operator with value-var `a` and criterion-value ref `b`
// (shared with the runtime registry via internal/codegen/builtin-ops). Null for non-codegen ops.
export { opExpr };

function buildFactory(criteria: ReadonlyArray<CompiledCriterion>): Factory | null {
  const lines: string[] = [
    `if (it === null || typeof it !== 'object') return false;`,
    `var arr = Array.isArray(it);`,
  ];
  for (let i = 0; i < criteria.length; i++) {
    const key = JSON.stringify(criteria[i].segments[0]); // exact key string, escaped
    const a = `a${i}`;
    const op = opExpr(String(criteria[i].operator), a, `vals[${i}]`);
    // Mirrors criterionMatches: array → numeric index in range (NaN/out-of-range = no match);
    // object → own/inherited key must be present (`in`); primitive already returned false above.
    lines.push(`var ${a};`);
    lines.push(`if (arr) { if (${key} === 'length') { ${a} = it.length; } else { var i${i} = +${key}; if (!(i${i} >= 0 && i${i} < it.length)) return false; ${a} = it[i${i}]; } } else { if (!(${key} in it)) return false; ${a} = it[${key}]; }`);
    lines.push(`if (!(${op})) return false;`);
  }
  lines.push(`return true;`);
  try {
    return new Function('vals', `return function(it){\n${lines.join('\n')}\n};`) as Factory;
  } catch {
    return null;
  }
}

/**
 * Returns a compiled predicate for `criteria`, or null when the interpreter must be used.
 * Cheap to call per query: the generated factory is cached by (segment,operator) signature
 * and bound to the current criterion values on each call.
 */
export function compileCriteriaPredicate(criteria: ReadonlyArray<CompiledCriterion>): CompiledPredicate | null {
  if (!canCompile() || !criteriaCodegenable(criteria)) return null;
  const factory = factories.getOrBuild(criteriaSignature(criteria), () => buildFactory(criteria));
  return factory ? factory(criteria.map((c) => c.value)) : null;
}
