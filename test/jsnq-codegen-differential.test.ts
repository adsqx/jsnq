/**
 * Randomized differential: the compiled criteria predicate and the compiled flat mutation must agree
 * with the interpreter (criteriaMatch / the general pipeline) on every item, for single- and
 * multi-segment paths over objects, arrays, nulls, primitives and odd keys ('length', '01', '').
 * Run: bun test/jsnq-codegen-differential.test.ts
 */
import { compileCriterion, criteriaMatch } from '../src/synced/core/match';
import { compileCriteriaPredicate } from '../src/synced/core/compiled-predicate';
import { JsnqPipeline, where, update, tryFastPipelineMutation } from '../src/synced';

let seed = 12345;
const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)];

const KEYS = ['a', 'b', 'meta', 'length', '0', '1', '01', 'x'];
const LEAVES = [0, 1, 2, 5, -1, '', 'a', 'ab', 'b', null, undefined, true, false];
function value(depth: number): unknown {
  const r = rnd(10);
  if (depth > 3 || r < 4) return pick(LEAVES);
  if (r < 7) { const o: Record<string, unknown> = {}; for (let i = rnd(4); i > 0; i--) o[pick(KEYS)] = value(depth + 1); return o; }
  return Array.from({ length: rnd(4) }, () => value(depth + 1));
}
const OPS = ['==', '===', '!=', '!==', '<', '<=', '>', '>=', 'includes', '!includes', 'startsWith', 'endsWith', 'isArray', 'isObject'] as const;
const VALUES = [0, 1, 2, 'a', 'b', '', null, undefined, true, false];

let checks = 0, failures = 0;
const ctx = { warnedUnknownOps: new Set<string>(), warnings: [] as string[] };
for (let round = 0; round < 3000; round++) {
  const criteria = Array.from({ length: 1 + rnd(2) }, () => {
    const path = Array.from({ length: 1 + rnd(3) }, () => pick(KEYS)).join('.');
    return compileCriterion(path, pick(OPS), pick(VALUES));
  });
  const compiled = compileCriteriaPredicate(criteria);
  if (!compiled) { failures++; console.error('❌ not compiled:', criteria.map((c) => c.segments.join('.'))); continue; }
  for (let k = 0; k < 20; k++) {
    const item = value(0);
    const expected = criteriaMatch(criteria, item, {}, ctx);
    checks++;
    if (compiled(item) !== expected) {
      failures++;
      if (failures < 10) console.error('❌ predicate', JSON.stringify(criteria.map((c) => [c.segments, c.operator, c.value])), JSON.stringify(item), 'expected', expected);
    }
  }
  // Flat mutation on a root array of the same items: compiled fast path vs the interpreter pipeline.
  const items = Array.from({ length: 8 }, () => value(1));
  const ops = criteria.map((c) => where(c.segments.join('.') as any, c.operator as any, c.value)) as any[];
  const viaPipeline = new JsnqPipeline(structuredClone(items) as any, { maxDepth: 1 }).pipe(...ops, update('hit', true));
  viaPipeline.all();
  const fast = tryFastPipelineMutation(structuredClone(items), [...ops, update('hit', true)]);
  if (fast !== undefined) {
    const general = new JsnqPipeline(structuredClone(items) as any).pipe(...ops, update('hit', true));
    general.all();
    checks++;
    if (JSON.stringify(fast.value) !== JSON.stringify(general.data)) {
      failures++;
      if (failures < 10) console.error('❌ fast mutation', JSON.stringify(criteria.map((c) => [c.segments, c.operator, c.value])), JSON.stringify(items));
    }
  }
}
// Exhaustive: every path of 1-3 keys over fixed items that exercise each branch.
const FIXED: unknown[] = [
  [{ x: 1, a: 'a' }, { x: 1, a: 'b' }, [1, 2]], { a: { b: 1, length: 2 }, '01': { x: 1 }, 1: { x: 2 }, meta: null },
  { a: [{ b: 1 }], length: 3, x: 'ab' }, [[{ x: 1 }]], [], { meta: { a: { b: 'a' } } }, [null, { x: 1 }], { a: 0 },
];
const PATH_KEYS = ['a', 'b', 'x', 'meta', 'length', '0', '1', '01'];
const paths: string[] = [];
for (const k1 of PATH_KEYS) { paths.push(k1); for (const k2 of PATH_KEYS) { paths.push(`${k1}.${k2}`); for (const k3 of PATH_KEYS) paths.push(`${k1}.${k2}.${k3}`); } }
for (const path of paths) for (const op of OPS) for (const v of [1, 'a', 2, null, true]) {
  const criteria = [compileCriterion(path, op, v)];
  const compiled = compileCriteriaPredicate(criteria);
  if (!compiled) { failures++; continue; }
  for (const item of FIXED) {
    checks++;
    if (compiled(item) !== criteriaMatch(criteria, item, {}, ctx)) {
      failures++;
      if (failures < 10) console.error('❌ exhaustive', path, op, v, JSON.stringify(item));
    }
  }
}

if (failures) { console.error(`\n${failures} of ${checks} differential checks failed`); process.exit(1); }
console.log(`All ${checks} codegen differential checks passed.`);
