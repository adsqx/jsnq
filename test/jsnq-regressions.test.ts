/**
 * Regressions for fixed engine bugs: objects created by an action are not re-matched, deep merge
 * skips forbidden keys, codegen honours registerOperator overrides, first() on an immutable
 * pipeline updates `.data`, and the flat fast paths agree with the general traversal.
 * Run: bun test/jsnq-regressions.test.ts
 */
import {
  JsnqPipeline, where, update, mergeUpdate, registerOperator, tryFastPipelineMutation, tryFastMutation, tryFastStructuralMutation,
  collectPipelineIntent, isDeepSugarAction, applyDeepSugarPatch, insert, deleteKey,
} from '../src/synced';

let failures = 0;
const ok = (cond: unknown, msg: string): void => {
  if (!cond) { failures++; console.error(`❌ ${msg}`); } else { console.log(`✅ ${msg}`); }
};
const J = (v: unknown) => JSON.stringify(v);
const run = (data: any, ...ops: any[]) => {
  const p = new JsnqPipeline(data).pipe(...ops);
  return { results: p.all().map((n) => n.data), data: p.data };
};

// 1. Objects created by an action are not visited by the same traversal.
{
  const r = run({}, update('a.b', 1));
  ok(J(r.data) === '{"a":{"b":1}}', 'update without where does not nest into the object it created');
  const t = run({ items: [{ a: 1 }] }, where('a', '==', 1), update('child', { a: 1 }));
  ok(J(t.data) === '{"items":[{"a":1,"child":{"a":1}}]}' && t.results.length === 1, 'a created value matching the criteria is not re-matched');
  const m = run({ items: [{ a: 1, meta: {} }] }, where('a', '==', 1), mergeUpdate('meta', { sub: { a: 1 } }, { deep: true }));
  ok(m.results.length === 1 && J(m.data) === '{"items":[{"a":1,"meta":{"sub":{"a":1}}}]}', 'children added by a merge are not re-matched');
  const kept = run({ x: { a: 1 }, y: { z: { a: 1 } } }, where('a', '==', 1), update('n', 1));
  ok(kept.results.length === 2 && J(kept.data) === '{"x":{"a":1,"n":1},"y":{"z":{"a":1,"n":1}}}', 'pre-existing nested matches are still found');
}

// 2. Deep merge never writes forbidden keys.
{
  const patch = JSON.parse('{"__proto__":{"polluted":1},"ok":{"constructor":{"prototype":{"bad":1}}}}');
  run({ items: [{ a: 1, meta: {} }] }, where('a', '==', 1), mergeUpdate('meta', patch, { deep: true }));
  ok((({}) as any).polluted === undefined && (({}) as any).bad === undefined, 'deep merge does not pollute Object.prototype');
}

// 3. First result on an immutable pipeline is reflected in `.data` and getStats().
{
  const source = { a: [{ v: 1 }, { v: 1 }] };
  const p = new JsnqPipeline(source).immutable().pipe(where('v', '==', 1), update('v', 2));
  const first = p.first<{ v: number }>();
  ok(first?.v === 2 && (p.data as any).a[0].v === 2, 'first() on an immutable pipeline updates .data');
  ok(source.a[0].v === 1, 'first() on an immutable pipeline leaves the source alone');
  ok(p.getStats().resultsFound === 1, 'first() updates getStats()');
}

// 4. Fast paths agree with the general traversal.
{
  // `length` heads: a nested array can match, so the flat scan must bail out.
  const data = [{ tags: [1, 2, 3] }, { tags: [1] }];
  const general = run(structuredClone({ root: data }), where('length', '==', 3), update('hit', true));
  const flat = run(structuredClone(data), where('length', '==', 3), update('hit', true));
  ok(general.results.length === 1 && flat.results.length === 1, 'length criterion finds nested arrays on a root array');
  const fast = tryFastPipelineMutation(structuredClone(data), [where('length', '==', 3), update('hit', true)]);
  ok(fast === undefined || J(fast.value) === J(flat.data), 'fast mutation bails out (or agrees) on a length criterion');

  // Array items: only `length` and in-range numeric indexes are readable, not prototype members.
  const items = [[1, 2], { push: 1 }, { 0: 5 }, [5]];
  const r = run(structuredClone(items), where('push', '!=', null), update('hit', true));
  ok(J(r.data) === J([[1, 2], { push: 1, hit: true }, { 0: 5 }, [5]]), 'compiled mutation does not read array prototype members');
  const idx = run(structuredClone(items), where('0', '==', 5), update('hit', true));
  ok(idx.results.length === 2, 'numeric index criteria match objects and arrays alike');
  const viaFast = tryFastPipelineMutation(structuredClone(items), [where('push', '!=', null), update('hit', true)]);
  ok(viaFast === undefined || J(viaFast.value) === J(r.data), 'fast mutation agrees with the pipeline on array items');
}

// 5. tryFastMutation is exactly the cascade the stores used to assemble by hand.
{
  const manual = (value: unknown, ops: any[]) => {
    const fast = tryFastPipelineMutation(value, ops, { collectAffectedPaths: true });
    if (fast) return fast;
    const intent = collectPipelineIntent(ops);
    const structural = tryFastStructuralMutation(value, intent);
    if (structural) return structural;
    if (intent.criteria.length > 0 && intent.actions.length > 0 && intent.actions.every(isDeepSugarAction)) {
      return { value: applyDeepSugarPatch(value, intent.criteria, intent.actions), mutations: 1, matched: 0, affectedPaths: null };
    }
    return undefined;
  };
  const rows = () => [{ id: 1, meta: { s: 1 } }, { id: 2, meta: { s: 2 } }];
  const cases: Array<[string, () => unknown, any[]]> = [
    ['flat update', rows, [where('id', '==', 2), update('meta.s', 9)]],
    ['flat delete', rows, [where('id', '>', 0), deleteKey('meta')]],
    ['structural insert', rows, [insert({ id: 3 } as any)]],
    ['sugar patch', () => ({ a: { b: { c: 1 } } }), [where('a.b.c', '==', 1), update({ z: 1 } as any)]],
    ['no fast path', () => ({ a: [{ x: 1 }] }), [where('x', '==', 1), update('x', 2)]],
  ];
  for (const [label, make, ops] of cases) {
    ok(JSON.stringify(tryFastMutation(make(), ops, { collectAffectedPaths: true })) === JSON.stringify(manual(make(), ops)), `tryFastMutation: ${label}`);
  }
}

// 6. Codegen honours registerOperator overrides of built-ins (kept last: it replaces '==').
{
  registerOperator('==', (a) => a === 'x');
  const r = run([{ v: 'x' }, { v: 'y' }], where('v', '==', 'y'), update('hit', true));
  ok(J(r.results.map((n: any) => n.v)) === '["x"]', 'an overridden built-in operator is used by the compiled paths');
  registerOperator('==', (a, b) => a == b);
}

if (failures) { console.error(`\n${failures} regression check(s) failed`); process.exit(1); }
console.log('\nAll jsnq regression checks passed.');
