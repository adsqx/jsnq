/** Helpers shared by the criteria-predicate and flat-mutation code generators. */
import type { CompiledCriterion } from '../types/operators';
import { isOperatorKnown } from '../../core/operators-registry';
import { createJsonPathPlan } from '../../core/data-engine';
import { builtinOp } from './builtin-ops';

let compileOk: boolean | null = null;
/** True when `new Function` works (false under a strict CSP). Probed once. */
export function canCompile(): boolean {
  if (compileOk !== null) return compileOk;
  try { new Function('return true'); compileOk = true; } catch { compileOk = false; }
  return compileOk;
}

export interface FactoryCache<F> {
  /** Cached factory for `sig`, building (and caching, even a null result) on first use. */
  getOrBuild(sig: string, build: () => F | null): F | null;
  setLimit(limit: number): void;
  clear(): void;
}

/** Signature -> generated-factory cache; it is cleared wholesale once it reaches `limit` entries. */
export function makeFactoryCache<F>(limit: number): FactoryCache<F> {
  const cache = new Map<string, F | null>();
  let max = limit;
  return {
    getOrBuild(sig, build) {
      let f = cache.get(sig);
      if (f === undefined) {
        f = build();
        if (cache.size >= max) cache.clear();
        cache.set(sig, f);
      }
      return f;
    },
    setLimit(n) { max = Math.max(0, n | 0); },
    clear() { cache.clear(); },
  };
}

/** Boolean source expression for a built-in operator, or null when it cannot be inlined. */
export function opExpr(op: string, a: string, b: string): string | null {
  return builtinOp(op)?.expr?.(a, b) ?? null;
}

/** Length-prefixed signature fragment (unambiguous for any string content). */
export const sigPart = (s: unknown): string => `${String(s).length}:${String(s)}`;

/** Codegen-able criteria: non-empty, all shallow, single-segment, inlinable built-in operators. */
export function criteriaCodegenable(criteria: ReadonlyArray<CompiledCriterion>): boolean {
  if (criteria.length === 0) return false;
  for (const c of criteria) {
    if (c.isDeep || c.segments.length !== 1 || c.segments[0] === undefined) return false;
    const op = String(c.operator);
    if (!isOperatorKnown(op) || opExpr(op, 'a', 'b') === null) return false;
  }
  return true;
}

/** Factory-cache signature of the (segment, operator) shape of `criteria`. */
export function criteriaSignature(criteria: ReadonlyArray<CompiledCriterion>): string {
  return criteria.map((c) => sigPart(c.segments[0]) + ':' + sigPart(c.operator)).join('|');
}

/** True when `key` is a non-empty string path with exactly one segment (throws for forbidden segments). */
export function isSingleSegmentKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && createJsonPathPlan(key).segments.length === 1;
}
