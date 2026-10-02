/**
 * The ergonomic entry points must be exact equivalents of the long-standing operators:
 * `where(fn)` / `where(key, fn)` vs `where(key, op, value)`, and `move()` / `copy()` vs the
 * moveTo / moveToMatches / moveToAll / moveToMatchesOverwrite / copyTo / copyToMatches / copyToAll family.
 * Run: bun test/jsnq-api-ergonomics.test.ts
 */
import {
  JsnqPipeline, where, update, deleteKey, move, copy,
  moveTo, moveToMatches, moveToAll, moveToMatchesOverwrite, copyTo, copyToMatches, copyToAll,
  tryFastPipelineMutation,
} from '../src/synced';
import type { JsonOperator } from '../src/synced';

let failures = 0;
const ok = (cond: unknown, msg: string): void => {
  if (!cond) { failures++; console.error(`❌ ${msg}`); } else { console.log(`✅ ${msg}`); }
};
const J = (v: unknown) => JSON.stringify(v);
const clone = <T>(v: T): T => structuredClone(v);

type Ops = JsonOperator<any>[];
/** Run both pipelines on fresh copies of `data` with `options`; compare data, results and stats. */
// The predicate form cannot be pre-screened against nested containers, so on trees and on arrays
// without `maxDepth: 1` it walks every node: traversal counters may differ, nothing else may.
function same(label: string, data: unknown, a: Ops, b: Ops, options: Record<string, unknown> = {}, traversalStats = true): void {
  const run = (ops: Ops) => {
    const d = clone(data);
    try {
      const p = new JsnqPipeline(d as any, options as any).pipe(...ops);
      const results = p.all().map((n: any) => n.data);
      const { searchTime, ...stats } = p.getStats() as any;
      if (!traversalStats) { delete stats.nodesVisited; delete stats.maxDepth; }
      return J({ data: p.data, results, stats });
    } catch (e) {
      return 'THROWS ' + (e as Error).message;
    }
  };
  const ra = run(a), rb = run(b);
  ok(ra === rb, `${label}${ra === rb ? '' : `\n   new: ${ra}\n   old: ${rb}`}`);
}

const flat = () => Array.from({ length: 50 }, (_, i) => ({ id: i, active: i % 3 === 0, meta: { score: i * 7 % 11 }, tags: ['a', i % 2 ? 'b' : 'c'] }));
const tree = {
  user: { profile: { name: 'Ann', age: 31 }, roles: ['admin'] },
  catalog: { items: [{ id: 1, type: 'item', price: 5 }, { id: 2, type: 'item', price: 12 }] },
  baskets: [{ type: 'basket', items: [] as unknown[] }, { type: 'basket', items: [] as unknown[] }],
  slots: [{ kind: 'slot', current: null }, { kind: 'slot', current: null }],
  done: [] as unknown[],
};

// ---- where(fn) ≡ where(key, op, value), on the flat fast path and on trees, every mode ----
for (const options of [{}, { immutable: true }, { immutable: 'auto' }, { dryRun: true }, { limit: 3 }]) {
  const tag = J(options);
  same(`where(fn) ≡ where(key,op,v) flat update ${tag}`, flat(),
    [where((r: any) => r.active === true), update('meta.score', 0)], [where('active', '===', true), update('meta.score', 0)], options, false);
  same(`where(fn) with maxDepth 1 takes the flat fast path (identical stats) ${tag}`, flat(),
    [where((r: any) => r.active === true), update('meta.score', 0)], [where('active', '===', true), update('meta.score', 0)], { ...options, maxDepth: 1 });
  same(`where(key, fn) ≡ where(key,op,v) flat ${tag}`, flat(),
    [where('meta.score', (s: any) => s > 5), deleteKey('tags')], [where('meta.score', '>', 5), deleteKey('tags')], options, false);
  same(`where(fn) ≡ where(key,op,v) tree ${tag}`, tree,
    [where((n: any) => n?.type === 'item'), update('price', 1)], [where('type', '===', 'item'), update('price', 1)], options, false);
  same(`where(key, fn) on a nested path ${tag}`, tree,
    [where('profile.age', (a: any) => a >= 18)], [where('profile.age', '>=', 18)], options, false);
}
same('where(fn) combined with string criteria (AND)', flat(),
  [where('active', '===', true), where((r: any) => r.id > 20)], [where('active', '===', true), where('id', '>', 20)], {}, false);
same('where(fn) on a deep @ key', { forms: [{ fields: [{ name: 'a' }, { name: 'b' }] }, { fields: [{ name: 'c' }] }] },
  [where('fields@name', (n: any) => n === 'b')], [where('fields@name', '===', 'b')], {}, false);
same('where(fn) with operatorsStrict: throw does not throw', flat(),
  [where((r: any) => r.id === 4)], [where('id', '===', 4)], { operatorsStrict: 'throw' }, false);

// The host copy-on-write fast path either handles the predicate form identically or declines
// (returns null/undefined so the host falls back to the general pipeline) — never a different result.
{
  const rows = flat();
  const a: any = tryFastPipelineMutation(rows, [where((r: any) => r.id === 3), update('active', false)] as any, {});
  const b: any = tryFastPipelineMutation(rows, [where('id', '===', 3), update('active', false)] as any, {});
  ok(a == null || J(a) === J(b), 'tryFastPipelineMutation: predicate form is handled identically or declined');
  ok(rows[3].active === true, 'tryFastPipelineMutation: input untouched (copy-on-write)');
}
{
  const p1 = where((r: any) => r.id === 1), p2 = where((r: any) => r.id === 2);
  ok(p1.__cacheKey === undefined && p2.__cacheKey === undefined, 'predicate operators carry no shared __cacheKey');
  ok(where('id', '===', 1).__cacheKey !== undefined, 'string where keeps its __cacheKey');
  ok(!(where((r: any) => true) as any).__isMutation, 'where(fn) is not a mutation');
}

// ---- move() / copy() ≡ the operator family ----
const sel = where('type', '===', 'item');
same("move('done') ≡ moveTo('done')", tree, [sel, move('done')], [sel, moveTo('done')]);
same("move(path, {mode:'before'}) ≡ moveTo(path,'before')", tree,
  [sel, move('baskets.0', { mode: 'before' })], [sel, moveTo('baskets.0', 'before')]);
same("move(path, {key}) on an object target ≡ moveTo(path, {key})", tree,
  [where('id', '===', 1), move('user', { key: 'favourite' })], [where('id', '===', 1), moveTo('user', { key: 'favourite' })]);
same("move({where}) ≡ moveToMatches", tree,
  [sel, move({ where: ['type', '===', 'basket'] })], [sel, moveToMatches('type', '===', 'basket')]);
same("move({where, into:'all'}) ≡ moveToAll", tree,
  [sel, move({ where: ['type', '===', 'basket'], into: 'all' })], [sel, moveToAll('type', '===', 'basket')]);
same("move({where}, {overwrite}) ≡ moveToMatchesOverwrite", tree,
  [sel, move({ where: ['kind', '===', 'slot'] }, { overwrite: 'current' })], [sel, moveToMatchesOverwrite('kind', '===', 'slot', 'current')]);
same("copy('done') ≡ copyTo('done')", tree, [sel, copy('done')], [sel, copyTo('done')]);
same("copy({where}) ≡ copyToMatches", tree,
  [sel, copy({ where: ['type', '===', 'basket'] })], [sel, copyToMatches('type', '===', 'basket')]);
same("copy({where, into:'all'}) ≡ copyToAll", tree,
  [sel, copy({ where: ['type', '===', 'basket'], into: 'all' })], [sel, copyToAll('type', '===', 'basket')]);
same("copy({where}, {mode:'after'}) ≡ copyToMatches(..., 'after')", tree,
  [sel, copy({ where: ['type', '===', 'basket'] }, { mode: 'after' })], [sel, copyToMatches('type', '===', 'basket', 'after')]);
ok((move('x') as any).__isMutation === true && (copy('x') as any).__isMutation === true, 'move/copy are mutation operators');

const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
ok(throws(() => move('done', { overwrite: 'x' })), "move(path, {overwrite}) throws (needs a where target)");
ok(throws(() => copy({ where: ['k', '===', 1] }, { overwrite: 'x' })), 'copy(..., {overwrite}) throws');
ok(throws(() => move({ where: ['k', '===', 1], into: 'all' }, { overwrite: 'x' })), "move({into:'all'}, {overwrite}) throws");

if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log('\nAll API ergonomics tests passed.');
