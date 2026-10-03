# Data engine

`@adsq/jsnq/data-engine` is the path layer that the pipeline is built on, exposed for hosts that
need to read, write and delete by path **without a pipeline**: state stores, form models, editors.
It is small (about 3 kB gzip when bundled on its own) and depends on nothing else in the package.

```ts
import {
  readJsonPath,
  writeJsonPath,
  deleteJsonPath,
  hasJsonPath,
  createJsonPathPlan,
} from '@adsq/jsnq/data-engine';
```

Everything here is also re-exported from the root entry `@adsq/jsnq`.

Unlike an `immutable` pipeline, **these functions mutate the object you pass in**. Clone first
(`cloneJsonData`) or use the [copy-on-write helpers](./pipeline.md#copy-on-write-host-helpers) when
you need a new value.

- [API at a glance](#api-at-a-glance)
- [Reading](#reading)
- [Writing](#writing)
- [Deleting](#deleting)
- [Mutation results](#mutation-results)
- [Path plans and the plan cache](#path-plans-and-the-plan-cache)
- [Lower-level pieces](#lower-level-pieces)
- [Safety](#safety)

## API at a glance

| Function | Returns | Description |
| --- | --- | --- |
| `readJsonPath<T>(root, pathOrPlan)` | `T \| undefined` | Value at the path; `undefined` when missing. `''` returns `root`. |
| `hasJsonPath(root, pathOrPlan)` | `boolean` | True when every segment exists as an own key (or in-range array index). |
| `writeJsonPath(root, pathOrPlan, value)` | `JsonMutationResult` | Set a value, creating missing containers. |
| `writeJsonPathValue(root, pathOrPlan, value)` | `boolean` | Same write without allocating a result object. `false` for the root path or an unwritable target. |
| `deleteJsonPath(root, pathOrPlan)` | `JsonMutationResult` | Delete a key; splice an array index. |
| `createJsonPathPlan(path)` | `JsonPathPlan` | Parse once, reuse many times (cached). |
| `createJsonPathPlanFromSegments(segments)` | `JsonPathPlan` | Build a plan from segments you already have (not cached). |
| `splitJsonPath(path)` | `string[]` | Just the segments. See [paths.md](./paths.md#path-syntax). |
| `getJsonBySegments<T>(obj, segments)` | `T \| undefined` | Read with raw segments (no parsing). |
| `getJsonParentSegments(pathOrPlan)` | `string[]` | Segments of the parent path. |
| `getJsonAffectedPaths(pathOrPlan, mode)` | `string[]` | `'exact'`: the path. `'branch'`: the path and each ancestor. |
| `resolveJsonParentAndKey(root, pathOrPlan, { create? })` | `{ parent, key, segments }` | Walk to the parent object of a path. |
| `createMutationResult(init)` | `JsonMutationResult` | Build a result object yourself (for hosts that synthesize mutations). |
| `cloneJsonData(value)` | `T` | Deep clone plain JSON-like data. |
| `setJsonPlanCacheLimit(n)`, `getJsonPlanCacheStats()`, `clearJsonPlanCache()` | | Control and inspect the plan cache. |
| `JsonDataCursor` | class | Remembers the last written branch to speed up repeated writes into one subtree. |
| `normalizeDotPath`, `splitDotPath`, `isValidDotPath`, `dotPathAncestors`, `resolveDependencyPath`, ... | | The stores' strict dot-path syntax. See [Dot paths](#dot-paths). |

## Reading

```ts
import { readJsonPath, hasJsonPath } from '@adsq/jsnq/data-engine';

const state = { users: [{ id: 1, profile: { 'display.name': 'Ada' } }] };

readJsonPath(state, 'users[0].id'); // => 1
readJsonPath(state, 'users.0.profile["display.name"]'); // => 'Ada'
readJsonPath(state, 'users.5.id'); // => undefined
readJsonPath<number>(state, 'users.0.id'); // => 1
hasJsonPath(state, 'users.0'); // => true
hasJsonPath(state, 'users.1'); // => false
```

Reads use plain property access, so a path can also reach inherited members
(`readJsonPath({}, 'toString')` is a function; `readJsonPath({ s: 'abc' }, 's.length')` is `3`).
Use `hasJsonPath`, which checks own keys and array bounds, when you need "does this key exist".
The three prototype segments are refused (see [Safety](#safety)).

## Writing

`writeJsonPath` creates every missing container on the way. A numeric next segment creates an
array, anything else an object. It returns a [`JsonMutationResult`](#mutation-results).

```ts
import { writeJsonPath, readJsonPath } from '@adsq/jsnq/data-engine';

const state: Record<string, unknown> = {};

const result = writeJsonPath(state, 'workspace.pages.0.title', 'Home');
state; // => { workspace: { pages: [{ title: 'Home' }] } }
result.kind; // => 'set'
result.existed; // => false
result.inserted; // => ['workspace.pages.0.title']
result.parents; // => ['workspace', 'workspace.pages', 'workspace.pages.0']

const rename = writeJsonPath(state, 'workspace.pages.0.title', 'Start');
rename.previous; // => 'Home'
rename.existed; // => true
readJsonPath(state, 'workspace.pages.0.title'); // => 'Start'
```

Write semantics to be aware of:

- **A container of the wrong kind is replaced.** Writing `a.b` when `a` is a primitive turns `a`
  into `{ b }`, and writing `a.0` when `a` is an object turns `a` into `[value]`. The old value is
  gone. Check with `hasJsonPath`/`readJsonPath` first if that could be a problem.
- Writing to the **root path** (`''`) does not modify anything; it only returns a result
  describing the intended set. Replace the root in your own code.
- `writeJsonPathValue(root, path, value)` performs the same write and returns a boolean, for hot
  paths that do their own change bookkeeping.

## Deleting

```ts
import { deleteJsonPath, hasJsonPath } from '@adsq/jsnq/data-engine';

const state = { tags: ['a', 'b', 'c'], meta: { draft: true } };

const removed = deleteJsonPath(state, 'meta.draft');
removed.kind; // => 'delete'
removed.previous; // => true
removed.deleted; // => ['meta.draft']
hasJsonPath(state, 'meta.draft'); // => false

deleteJsonPath(state, 'tags.0'); // splices: later elements shift down
state.tags; // => ['b', 'c']

deleteJsonPath(state, 'nope.x').existed; // => false
```

## Mutation results

`writeJsonPath` and `deleteJsonPath` describe what they did, so a host can notify exactly the
right subscribers:

| Field | Meaning |
| --- | --- |
| `path` | The normalized path that was written or deleted. |
| `kind` | `'set'`, `'delete'` or `'noop'`. |
| `previous`, `next` | Value before and after (`next` for sets, `previous` for both). |
| `existed` | Whether the key was already present. |
| `changed` | Paths whose value changed. |
| `inserted` | Paths that did not exist before (empty when overwriting). |
| `deleted` | Paths removed. |
| `parents` | Ancestor paths of the target (computed lazily). |
| `descendants` | Descendant paths affected by replacing a branch. |
| `branchReplaced` | True when an object/array was replaced or removed, so descendants changed too. |
| `affectedPaths` | The de-duplicated union a subscriber layer would notify: exact path for a leaf write, the whole ancestor chain for a delete. |

```ts
import { writeJsonPath } from '@adsq/jsnq/data-engine';

const state = { list: [{ a: 1 }] };

const leaf = writeJsonPath(state, 'list.0.a', 2);
leaf.affectedPaths; // => ['list.0.a']
leaf.branchReplaced; // => false

const branch = writeJsonPath(state, 'list.0', { a: 3 });
branch.branchReplaced; // => true
branch.previous; // => { a: 2 }
```

## Path plans and the plan cache

A `JsonPathPlan` is a parsed path: `{ path, segments, parentSegments, key, nextIsIndex }`.
Every function that takes a path also accepts a plan, which skips parsing. `createJsonPathPlan(path)`
keeps parsed plans in a bounded cache, so repeated string paths are already cheap; keep a plan
yourself for a path used in a tight loop.

```ts
import { createJsonPathPlan, getJsonAffectedPaths, getJsonPlanCacheStats, clearJsonPlanCache, setJsonPlanCacheLimit } from '@adsq/jsnq/data-engine';

const plan = createJsonPathPlan('users.0.name');
plan.segments; // => ['users', '0', 'name']
plan.parentSegments; // => ['users', '0']
plan.key; // => 'name'
plan.nextIsIndex; // => [true, false]
getJsonAffectedPaths(plan, 'branch'); // => ['users', 'users.0', 'users.0.name']

clearJsonPlanCache();
createJsonPathPlan('a.b');
createJsonPathPlan('a.b');
getJsonPlanCacheStats().hits; // => 1
getJsonPlanCacheStats().limit; // => 5000

setJsonPlanCacheLimit(100); // floor is 16 plans
```

The cache holds up to 5000 plans by default and evicts a whole older generation at once. The same
cache serves the pipeline's own path parsing. `setPathCacheLimit(n)` (root entry) is the same knob.

## Lower-level pieces

- `JsonDataCursor`: `prefetch(path, node)`, `writeWithPlan(root, plan, value)`,
  `invalidateForDeletion(path)`, `clear()`, `active`. It remembers the parent of the last write and
  starts the next write from there when the new path shares that prefix. Useful for many writes
  into one subtree. Call `invalidateForDeletion` when you delete a branch it may be pointing into.
- `resolveJsonParentAndKey(root, path, { create })` returns the parent container and final key
  without writing the value.
- `createMutationResult(init)` builds a `JsonMutationResult` from explicit `changed`, `inserted`,
  `deleted`, ... lists.
- `cloneJsonData(value)` deep-clones plain arrays and objects (shared references and cycles are
  preserved, sparse array holes stay holes). Class instances such as `Date` go through
  `structuredClone` when it is available.

## Dot paths

The Angular and Solid signal stores accept a stricter path syntax than the engine: identifier keys
and array indexes joined by dots, with `a[0]` accepted as `a.0`. These helpers implement it once for
both stores. Results of normalizing bracket paths, splitting and validating are cached (bounded,
generational eviction); `clearDotPathCaches()` drops them.

| Function | Result |
| --- | --- |
| `normalizeDotPath(path)` | `'users[0].name'` -> `'users.0.name'`; `''` for an empty path. |
| `splitDotPath(normalized)` | Cached segments; empty segments are kept. Do not mutate the array. |
| `isValidDotPath(path)` / `isValidNormalizedDotPath(normalized)` | Identifier or index segments only, none of `__proto__` / `prototype` / `constructor`. |
| `dotPathParent(normalized)` | `'a.b.c'` -> `'a.b'`; `null` for a top-level key (no validation). |
| `dotPathIndexContainer(path)` | Container above the first index: `'tree.0.fields'` -> `'tree'`; `null` otherwise. |
| `dotPathAncestors(path)` | `'a.0.b'` -> `['a.0.b', 'a.0', 'a']`; `[]` for an invalid path. |
| `new GenerationalCache<V>(limit)` | The bounded cache behind these helpers (`get` / `set` returning the value / `clear`), O(1) eviction; holds `limit` to `2 * limit` entries. Both stores use it for their path caches. |
| `resolveDependencyPath(normalized, { dependencyMode, bumpNumericParent })` | The path a reactive store tracks: the path itself (`'exact'`) or its parent (`'container'`), optionally lifted to the container above the first index. |

## Safety

`__proto__`, `prototype` and `constructor` are rejected as segments of a string path or a plan;
compiling the path throws `Unsafe path segment in '<path>'`. `getJsonBySegments`, which takes raw
segments, returns `undefined` for them instead of handing back `Object.prototype`. Both behaviours are
covered by `test/jsnq-prototype-guard.test.ts`. `cloneJsonData` keeps an own `__proto__` key that
arrived through `JSON.parse` as ordinary data on the clone; it never changes the clone's prototype.

```ts
import { writeJsonPath, readJsonPath } from '@adsq/jsnq/data-engine';

try {
  writeJsonPath({}, '__proto__.polluted', true);
} catch (error) {
  (error as Error).message; // => "Unsafe path segment in '__proto__.polluted'"
}
readJsonPath({}, 'a.b'); // => undefined
({} as { polluted?: boolean }).polluted; // => undefined
```

See [Safety in the README](../README.md#safety) for what the guard does and does not cover.
