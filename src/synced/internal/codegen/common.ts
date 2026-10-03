/** Helpers shared by the criteria-predicate and flat-mutation code generators, plus the per-action source templates. */
import type { ActionMap, ActionType } from '../types/actions';
import type { CompiledCriterion } from '../types/model';
import { getOperatorFn } from '../../core/operators-registry';
import { createJsonPathPlan, type JsonPathPlan } from '../../core/data-engine';
import { isForbiddenSegment, isNumericSegment } from '../guards';
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

/** Codegen-able criteria: non-empty, all shallow, string paths without forbidden segments, inlinable (non-overridden) built-in operators. */
export function criteriaCodegenable(criteria: ReadonlyArray<CompiledCriterion>): boolean {
  if (criteria.length === 0) return false;
  for (const c of criteria) {
    if (c.isDeep || c.segments.length === 0) return false;
    for (const seg of c.segments) if (typeof seg !== 'string' || isForbiddenSegment(seg)) return false;
    const op = String(c.operator);
    // Inline only a built-in that has not been overridden through registerOperator.
    const builtin = builtinOp(op);
    if (!builtin?.expr || getOperatorFn(op) !== builtin.fn) return false;
  }
  return true;
}

/**
 * Source lines that read each criterion's value from the object `it` into `a<i>` and run `fail` on a
 * mismatch. Mirrors criterionMatches: the head must be present (array → `length` or an in-range
 * index; object → key `in` it), then the rest of the path is walked like getJsonBySegments (a nullish
 * step reads as `undefined`). Constant keys compile to direct property loads.
 */
export function criteriaCheckSource(criteria: ReadonlyArray<CompiledCriterion>, fail: string): string[] {
  const lines = [`var arr = Array.isArray(it);`];
  for (let i = 0; i < criteria.length; i++) {
    const [head, ...rest] = criteria[i].segments as string[];
    const key = JSON.stringify(head);
    const a = `a${i}`;
    const walk = rest.map((seg) => ` ${a} = ${a} == null ? undefined : ${a}[${JSON.stringify(seg)}];`).join('');
    const arrayRead = head === 'length'
      ? (rest.length === 0 ? `${a} = it.length;` : `${a} = it.length;${walk}`)
      // A single index reads numerically (as criterionMatches does); a longer path walks by the key string.
      : `var i${i} = +${key}; if (!(i${i} >= 0 && i${i} < it.length)) ${fail}; ${a} = it[${rest.length === 0 ? `i${i}` : key}];${walk}`;
    lines.push(
      `var ${a};`,
      `if (arr) { ${arrayRead} } else { if (!(${key} in it)) ${fail}; ${a} = it[${key}];${walk} }`,
      `if (!(${opExpr(String(criteria[i].operator), a, `vals[${i}]`)})) ${fail};`,
    );
  }
  return lines;
}

/** Factory-cache signature of the (path, operator) shape of `criteria`. */
export function criteriaSignature(criteria: ReadonlyArray<CompiledCriterion>): string {
  return criteria.map((c) => c.segments.map(sigPart).join('.') + ':' + sigPart(c.operator)).join('|');
}

/** True when `key` is a non-empty string path with exactly one segment (throws for forbidden segments). */
export function isSingleSegmentKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && createJsonPathPlan(key).segments.length === 1;
}

/** Action types the compiled loop can handle (all others use the interpreter). */
type CodegenType = Extract<ActionType, 'update' | 'replace' | 'delete_key' | 'merge_update'>;
export type CodegenAction = ActionMap[CodegenType];

const CODEGEN_TYPES: ReadonlySet<ActionType> = new Set<CodegenType>(['update', 'replace', 'delete_key', 'merge_update']);

export function isCodegenAction(a: { type: ActionType }): a is CodegenAction {
  return CODEGEN_TYPES.has(a.type);
}

/** The runtime value bound into the generated loop's `vals` array for this action. */
export function actionValue(a: CodegenAction): unknown {
  return a.type === 'merge_update' ? a.patch : a.type === 'delete_key' ? undefined : a.value;
}

const OBJECT_LIKE = (v: string): string => `(${v} !== null && (typeof ${v} === 'object' || typeof ${v} === 'function'))`;

/** `parent[key] = value` with the engine's array rule: a numeric key on an array writes the numeric index. */
function assignSource(parent: string, key: string, value: string): string {
  const k = JSON.stringify(key);
  // '1' and 1 address the same array slot; only non-canonical numerals ('01') need the array test.
  if (!isNumericSegment(key) || String(Number(key)) === key) return `${parent}[${k}] = ${value};`;
  return `if (Array.isArray(${parent})) ${parent}[${Number(key)}] = ${value}; else ${parent}[${k}] = ${value};`;
}

/**
 * Statements applying a value action at `plan` of `target`, mirroring the interpreter (core/actions +
 * the data engine): writes walk the parent segments creating (or replacing a wrongly shaped) child as
 * `[]` before an index segment and `{}` otherwise; deletes stop at a missing parent and splice an
 * in-range array index. `val` is the source ref of the value/patch, `n` a unique suffix.
 */
export function actionSource(a: CodegenAction, plan: JsonPathPlan, val: string, n: number): string {
  const { parentSegments, nextIsIndex, key } = plan;
  const t = `t${n}`, c = `c${n}`;
  const walk = (create: boolean, label: string): string => parentSegments.map((seg, j) => {
    const fits = `${OBJECT_LIKE(c)}${nextIsIndex[j] ? ` && Array.isArray(${c})` : ''}`;
    const miss = create ? `{ ${c} = ${nextIsIndex[j] ? '[]' : '{}'}; ${t}[${JSON.stringify(seg)}] = ${c}; }` : `break ${label};`;
    return ` ${c} = ${t}[${JSON.stringify(seg)}]; if (!(${fits})) ${miss} ${t} = ${c};`;
  }).join('');
  const head = `var ${t} = target, ${c};`;
  if (a.type === 'delete_key') {
    const k = key!;
    const remove = isNumericSegment(k)
      ? `if (Array.isArray(${t})) { if (${Number(k)} < ${t}.length) ${t}.splice(${Number(k)}, 1); } else delete ${t}[${JSON.stringify(k)}];`
      : `delete ${t}[${JSON.stringify(k)}];`;
    return `if (!dryRun) d${n}: { ${head}${walk(false, `d${n}`)} ${remove} }`;
  }
  let value = val;
  let prologue = '';
  if (a.type === 'merge_update') {
    // Current value read like getJsonBySegments; a shallow merge of two objects, else the patch.
    const cur = `m${n}`;
    const read = plan.segments.map((seg, j) => (j === 0 ? ` ${cur} = target[${JSON.stringify(seg)}];` : ` ${cur} = ${cur} == null ? undefined : ${cur}[${JSON.stringify(seg)}];`)).join('');
    prologue = ` var ${cur};${read} ${cur} = (${cur} !== null && typeof ${cur} === 'object' && ${val} !== null && typeof ${val} === 'object') ? Object.assign({}, ${cur}, ${val}) : ${val};`;
    value = cur;
  }
  return `if (!dryRun) {${prologue} ${head}${walk(true, '')} ${assignSource(t, key!, value)} }`;
}

/** True when `key` parses to a path with at least one segment (throws for forbidden segments). */
export function isPathKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && createJsonPathPlan(key).segments.length > 0;
}
