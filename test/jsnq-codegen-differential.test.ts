/**
 * Randomized differential: the compiled criteria predicate and the compiled flat mutation must agree
 * with the interpreter (criteriaMatch / the general pipeline) on every item, for single- and
 * multi-segment paths over objects, arrays, nulls, primitives and odd keys ('length', '01', '').
 * Run: bun test/jsnq-codegen-differential.test.ts
 */
import { compileCriterion, criteriaMatch } from '../src/synced/core/match';
import { compileCriteriaPredicate } from '../src/synced/core/compiled-predicate';
import { JsnqPipeline, where, update, replace, deleteKey, mergeUpdate, tryFastPipelineMutation } from '../src/synced';
import { compileFlatMutation } from '../src/synced/core/compiled-mutation';

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

// Value actions with single and nested keys: the compiled loop (no limit) vs the interpreter scan
// (a limit disables codegen), on data, results, stats, warnings and operation log, across options.
const ACTION_KEYS = ['a', 'b', 'x', 'meta', '0', '1', '01', 'length'];
const actionKey = (): string => Array.from({ length: 1 + rnd(3) }, () => pick(ACTION_KEYS)).join('.');
const makeAction = (): any => {
  const key = actionKey();
  switch (rnd(4)) {
    case 0: return update(key as any, value(2) as any);
    case 1: return replace(key as any, value(2) as any);
    case 2: return deleteKey(key as any);
    default: return mergeUpdate(key as any, (rnd(2) ? { a: 1, n: value(3) } : value(3)) as any);
  }
};
const runPipeline = (items: unknown[], ops: any[], options: Record<string, unknown>): string => {
  try {
    const p = new JsnqPipeline(structuredClone(items) as any, { maxDepth: 1, ...options }).pipe(...ops);
    const results = p.all().map((n: any) => n.data);
    const { searchTime, ...stats } = p.getStats() as any;
    return JSON.stringify({ data: p.data, results, stats });
  } catch (e) {
    return 'THROWS ' + (e as Error).constructor.name;
  }
};
let compiledCases = 0;
for (let round = 0; round < 6000; round++) {
  const items = Array.from({ length: 6 }, () => value(1));
  const crit = Array.from({ length: rnd(2) + 1 }, () => [Array.from({ length: 1 + rnd(2) }, () => pick(KEYS)).join('.'), pick(OPS), pick(VALUES)] as const);
  const ops = [...crit.map(([k, o, v]) => where(k as any, o as any, v)), ...Array.from({ length: 1 + rnd(3) }, makeAction)];
  const options = { dryRun: rnd(5) === 0, strictPathsWarn: rnd(2) === 0, immutable: rnd(3) === 0, trackOperations: rnd(4) !== 0 };
  const probe = new JsnqPipeline([] as any).pipe(...ops);
  if (compileFlatMutation(probe.criteria, probe.actions)) compiledCases++;
  const compiled = runPipeline(items, ops, options);
  const interpreted = runPipeline(items, ops, { ...options, limit: 1e9 });
  checks++;
  if (compiled !== interpreted) {
    failures++;
    if (failures < 10) console.error('❌ actions', JSON.stringify(probe.actions), JSON.stringify(crit), JSON.stringify(options), '\n   compiled:   ', compiled.slice(0, 300), '\n   interpreted:', interpreted.slice(0, 300));
  }
}
// Exhaustive actions over fixed items that hit every branch: missing / wrongly shaped / null parents,
// array targets with canonical and non-canonical ('01') indexes, 'length', dryRun, warnings, immutability.
const ITEMS: unknown[] = [
  { a: 1, meta: { x: 1 }, 0: {}, x: [1, 2], b: 'str' }, { a: { b: [{ x: 1 }] }, x: 'str', meta: null, 1: [] },
  [{ a: 1 }, [1, 2, 3], null], { a: [0, 1, { x: 2 }], '01': 5, b: { 0: 1 } }, [[1], [2]], { a: 1, x: { 0: { a: 1 } } },
];
const CRITS = [['a', '!=', 'zzz'], ['length', '>=', 0], ['0', '!=', 'zzz']] as const;
const KEYS2: string[] = [];
for (const k1 of ACTION_KEYS) { KEYS2.push(k1); for (const k2 of ACTION_KEYS) KEYS2.push(`${k1}.${k2}`); }
KEYS2.push('x.0.y', 'meta.a.b', 'a.1.x', '0.0.0', '01.a.0', 'a.b.0.x', 'b.0.1', 'x.01.a', 'a.2.x.0');
const ACTION_MAKERS = [
  (k: string) => update(k as any, { n: 1 } as any), (k: string) => update(k as any, 7 as any), (k: string) => replace(k as any, [9] as any),
  (k: string) => deleteKey(k as any), (k: string) => mergeUpdate(k as any, { m: 1 } as any), (k: string) => mergeUpdate(k as any, 5 as any),
];
const OPTION_SETS = [{}, { dryRun: true }, { strictPathsWarn: true }, { immutable: true }, { trackOperations: false }];
for (const [ck, co, cv] of CRITS) for (const key of KEYS2) for (const make of ACTION_MAKERS) for (const options of OPTION_SETS) {
  const ops = [where(ck as any, co as any, cv), make(key)];
  const compiled = runPipeline(ITEMS, ops, options);
  const interpreted = runPipeline(ITEMS, ops, { ...options, limit: 1e9 });
  checks++;
  if (compiled !== interpreted) {
    failures++;
    if (failures < 10) console.error('❌ exhaustive action', ck, key, JSON.stringify(new JsnqPipeline([] as any).pipe(...ops).actions), JSON.stringify(options), '\n   compiled:   ', compiled.slice(0, 400), '\n   interpreted:', interpreted.slice(0, 400));
  }
}

if (compiledCases < 3000) { failures++; console.error(`❌ only ${compiledCases} action cases compiled`); }

if (failures) { console.error(`\n${failures} of ${checks} differential checks failed`); process.exit(1); }
console.log(`All ${checks} codegen differential checks passed.`);
