/** Helpers shared by the criteria-predicate and flat-mutation code generators, plus the per-action source templates. */
import type { ActionMap, ActionType } from '../types/actions';
import type { CompiledCriterion } from '../types/model';
import { getOperatorFn } from '../../core/operators-registry';
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

/** Codegen-able criteria: non-empty, all shallow, single-segment, inlinable (non-overridden) built-in operators. */
export function criteriaCodegenable(criteria: ReadonlyArray<CompiledCriterion>): boolean {
  if (criteria.length === 0) return false;
  for (const c of criteria) {
    if (c.isDeep || c.segments.length !== 1 || c.segments[0] === undefined) return false;
    const op = String(c.operator);
    // Inline only a built-in that has not been overridden through registerOperator.
    const builtin = builtinOp(op);
    if (!builtin?.expr || getOperatorFn(op) !== builtin.fn) return false;
  }
  return true;
}

/**
 * Source lines that read each criterion's value from the object `it` into `a<i>` and run `fail` on a
 * mismatch. Mirrors criterionMatches: array → `length` or an in-range numeric index; object → key `in` it.
 */
export function criteriaCheckSource(criteria: ReadonlyArray<CompiledCriterion>, fail: string): string[] {
  const lines = [`var arr = Array.isArray(it);`];
  for (let i = 0; i < criteria.length; i++) {
    const key = JSON.stringify(criteria[i].segments[0]); // exact key string, escaped
    const a = `a${i}`;
    lines.push(
      `var ${a};`,
      `if (arr) { if (${key} === 'length') { ${a} = it.length; } else { var i${i} = +${key}; if (!(i${i} >= 0 && i${i} < it.length)) ${fail}; ${a} = it[i${i}]; } } else { if (!(${key} in it)) ${fail}; ${a} = it[${key}]; }`,
      `if (!(${opExpr(String(criteria[i].operator), a, `vals[${i}]`)})) ${fail};`,
    );
  }
  return lines;
}

/** Factory-cache signature of the (segment, operator) shape of `criteria`. */
export function criteriaSignature(criteria: ReadonlyArray<CompiledCriterion>): string {
  return criteria.map((c) => sigPart(c.segments[0]) + ':' + sigPart(c.operator)).join('|');
}

/** True when `key` is a non-empty string path with exactly one segment (throws for forbidden segments). */
export function isSingleSegmentKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && createJsonPathPlan(key).segments.length === 1;
}

export interface ActionCodegen {
  /** Tail of the strictPathsWarn message: `<type>: path '<key>' did not exist<warnMsg>`. */
  warnMsg: string;
  /** Statement applying the action to `target[key]` (`val` = source ref of the action's value/patch). */
  emit: (key: string, val: string, i: number) => string;
}

/** Action types the compiled loop can handle (all others use the interpreter). */
type CodegenType = Extract<ActionType, 'update' | 'replace' | 'delete_key' | 'merge_update'>;
export type CodegenAction = ActionMap[CodegenType];

const assign = (key: string, val: string): string => `if (!dryRun) target[${key}] = ${val};`;

export const ACTION_CODEGEN: { readonly [K in CodegenType]: ActionCodegen } = {
  update: { warnMsg: '; created implicitly', emit: assign },
  replace: { warnMsg: '; created implicitly', emit: assign },
  delete_key: { warnMsg: '', emit: (key) => `if (!dryRun) delete target[${key}];` },
  merge_update: {
    warnMsg: '; created implicitly',
    emit: (key, patch, i) =>
      `if (!dryRun) { var current${i} = target[${key}]; target[${key}] = (current${i} !== null && typeof current${i} === 'object' && ${patch} !== null && typeof ${patch} === 'object') ? Object.assign({}, current${i}, ${patch}) : ${patch}; }`,
  },
};

export function isCodegenAction(a: { type: ActionType }): a is CodegenAction {
  return Object.hasOwn(ACTION_CODEGEN, a.type);
}

/** The runtime value bound into the generated loop's `vals` array for this action. */
export function actionValue(a: CodegenAction): unknown {
  return a.type === 'merge_update' ? a.patch : a.type === 'delete_key' ? undefined : a.value;
}
