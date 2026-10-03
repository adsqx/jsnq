/**
 * Dot paths: the strict store path syntax shared by the Angular and Solid stores.
 * Run: bun test/jsnq-dot-path.test.ts
 */
import {
  clearDotPathCaches, dotPathAncestors, dotPathIndexContainer, dotPathParent, isValidDotPath, isValidNormalizedDotPath,
  normalizeDotPath, resolveDependencyPath, splitDotPath,
} from '../src/synced/core/data-engine';

let failures = 0;
const ok = (cond: unknown, msg: string): void => {
  if (!cond) { failures++; console.error(`❌ ${msg}`); } else { console.log(`✅ ${msg}`); }
};
const J = (v: unknown) => JSON.stringify(v);

for (const pass of ['cold', 'cached']) {
  ok(normalizeDotPath('users[0].name') === 'users.0.name' && normalizeDotPath('a.b') === 'a.b' && normalizeDotPath('') === '', `${pass}: normalize`);
  ok(J(splitDotPath('a.0.b')) === '["a","0","b"]' && J(splitDotPath('')) === '[]' && J(splitDotPath('a..b')) === '["a","","b"]', `${pass}: split keeps empty segments`);
  ok(splitDotPath('x.y') === splitDotPath('x.y'), `${pass}: split is cached`);
  ok(isValidDotPath('a.b_1.$c.0') && isValidDotPath('items[2].name'), `${pass}: valid paths`);
  ok(![ '', ' a', 'a.', '.a', 'a..b', '0a', 'a-b', 'a.__proto__', 'constructor', 'a.prototype.b', null as any, 5 as any].some(isValidDotPath), `${pass}: invalid and forbidden paths`);
  ok(isValidNormalizedDotPath('a.0') && !isValidNormalizedDotPath('a[0]') && isValidNormalizedDotPath('a.__proto__x'), `${pass}: normalized validation`);
  ok(dotPathParent('a.b.c') === 'a.b' && dotPathParent('a') === null, `${pass}: parent`);
  ok(dotPathIndexContainer('tree.0.fields.2') === 'tree' && dotPathIndexContainer('a.b') === null && dotPathIndexContainer('0.a') === null && dotPathIndexContainer('a..0') === null, `${pass}: index container`);
  ok(J(dotPathAncestors('users[0].name')) === '["users.0.name","users.0","users"]' && J(dotPathAncestors('a.__proto__')) === '[]', `${pass}: ancestors`);
  const exact = { dependencyMode: 'exact', bumpNumericParent: false } as const;
  const container = { dependencyMode: 'container', bumpNumericParent: false } as const;
  const bump = { dependencyMode: 'exact', bumpNumericParent: true } as const;
  ok(resolveDependencyPath('a.b.c', exact) === 'a.b.c' && resolveDependencyPath('a.b.c', container) === 'a.b' && resolveDependencyPath('a', container) === 'a', `${pass}: dependency path modes`);
  ok(resolveDependencyPath('list.3.name', bump) === 'list' && resolveDependencyPath('list.3', { dependencyMode: 'container', bumpNumericParent: true }) === 'list', `${pass}: dependency path bumps to the list`);
}
clearDotPathCaches();
ok(normalizeDotPath('k[1]') === 'k.1' && isValidDotPath('k[1]'), 'caches refill after clear');

if (failures) { console.error(`\n${failures} dot-path check(s) failed`); process.exit(1); }
console.log('\nAll dot-path checks passed.');
