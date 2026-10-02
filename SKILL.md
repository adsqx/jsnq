---
name: jsnq
description: Use @adsq/jsnq to query and change JSON with a pipeline of operators — where() finds nodes at any depth, update/mergeUpdate/deleteKey edit them, moveTo/copyTo/insert/deleteElement restructure trees, in place, on a clone, or copy-on-write. Includes a standalone path read/write/delete engine and typed paths. Use when writing or reviewing code that imports @adsq/jsnq, or that queries and mutates nested JSON arrays and trees through the JSNQ operators of @adsq/solid-signal-store or @adsq/angular-signal-store.
---

# @adsq/jsnq

A framework-agnostic, zero-dependency JSON pipeline engine. You build a pipeline of operators
with `pipe()`, then run it with `all()`, `first()` or `count()`. It works on flat arrays and on
deeply nested trees.

Install: `npm install @adsq/jsnq`. The stores `@adsq/solid-signal-store` and
`@adsq/angular-signal-store` depend on it as a peer and call it through their `mutate` / `$query`
methods.

## The mental model — read this first

1. **A match is any node in the tree, not a row of an array.** The pipeline visits the root and
   every descendant (arrays in order, objects in key order) down to `maxDepth` (default 10).
   `where('id', '===', 2)` matches every object with `id` 2, at any depth.
2. **`where()` adds criteria (AND-combined); every other operator adds an action.** Actions run on
   each match in the order written. Order between `where` and actions does not matter.
3. **No `where()` means every node matches**, root included. An `update` without a criterion
   touches the root and each descendant. Always start with `where()` unless that is the goal.
4. **`pipe()` only describes. A terminal call runs it, and every terminal call runs it again.**
   Call exactly one of `all()` / `first()` / `count()`, then read `pipeline.data`. Calling `all()`
   then `count()` on a mutating pipeline applies the actions twice (`n => n + 1` runs twice).
5. **By default the input is mutated in place.** Pass `{ immutable: true }` to work on a clone.

## Basic use

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

const users = [{ id: 1, active: true, score: 1 }, { id: 2, active: false, score: 5 }];

const pipeline = new JsnqPipeline(users, { immutable: true })
  .pipe(where('active', '===', true), update('score', (n: number) => n + 1));

pipeline.all();                 // run once
const next = pipeline.data;     // updated clone; `users` is untouched
next; // => [{ id: 1, active: true, score: 2 }, { id: 2, active: false, score: 5 }]
users[0].score; // => 1
```

- `all()` returns nodes `{ data, path, depth, ... }`; `first<T>()` returns the first matched value
  or `null`; `count()` returns a number; `getStats()` returns counters and `warnings`.
- Import operators from `@adsq/jsnq/operators/<name>` (default exports) so bundlers keep only
  what is used. The root `@adsq/jsnq` also exports them all by name.
- Use `dryRun()` to see what would happen (`getStats()`), without writing.

## Operators

| Operator | Signature | Notes |
| --- | --- | --- |
| `where` | `(path, op, value)` | Ops: `== === != !== > >= < <= includes !includes startsWith endsWith regex isArray isObject` or a `registerOperator` name. |
| `where` | `(node => bool)` / `(path, value => bool)` | Plain predicate; annotate the parameter to type it. Add `{ maxDepth: 1 }` on flat arrays to keep the fast scan. |
| `update` / `replace` | `(path, valueOrFn)` | `fn(current, node)`. Creates missing containers. |
| `mergeUpdate` | `(path, patch, { deep? })` | Shallow by default. Arrays in a deep merge follow `arrayMergeStrategy`. |
| `deleteKey` | `(path)` | Deletes the key; splices an array index. |
| `deleteElement` | `()` | Removes each match from its parent. |
| `insert` | `(data, 'inside' \| 'before' \| 'after', key?)` | Relative to each match. |
| `insertTo` | `(path, data, mode?, key?)` | Needs no match; runs once. |
| `move` / `copy` | `(to, { mode?, key?, overwrite? })` | **Preferred.** `to` = path, or `{ where: [key, op, value], into?: 'first' \| 'all' }`; `overwrite` (move only) sets `target[overwrite]`. |
| `moveTo` / `copyTo` | `(path, mode?, key?)` | Move or deep-copy each match to a path (= `move(path)`). |
| `moveToMatches` / `copyToMatches` | `(targetKey, op, value, mode?, key?)` | All sources into the FIRST selected target. |
| `moveToAll` / `copyToAll` | same | Sources into EVERY selected target. |
| `moveToMatchesOverwrite` | `(targetKey, op, value, overwriteKey)` | Sets `target[overwriteKey]`. |

## Paths

`a.b`, `users.0.name`, `users[0].name`, `settings["display.name"]`, `a\.b` all work. In `where()`
the path is relative to the visited node. Special forms:

- `where('fields@id', '===', 'x')` searches the array at `fields` and every nested `fields` array.
- `$.baskets[0].items` is an absolute target selector for the `*Matches` / `*All` operators (the
  operator and value are ignored); `*` matches any one segment: `$.baskets.*.items`.
- Wildcards are NOT supported in `where()` paths.

## Structural rules that trip people up

- **Inserting into an object needs an explicit string key**: `copyTo('archive', 'inside', 'card-1')`,
  `insertTo('meta', data, 'inside', 'note')`. Without one it throws before anything changes.
  Arrays take an optional numeric index: `moveTo('list', 'inside', 0)`.
- A path that does not exist yet is created as an object (a numeric next segment creates an
  array). Create the array first, or give a key.
- Relative target selectors pick the nodes that SATISFY the criterion.
  `moveToMatches('items', 'isArray', true)` targets objects that HAVE an `items` array, not the
  array. To target an array use `('length', '===', 0)` or a `$` path.
- `moveToMatches` uses one target, `moveToAll` uses all of them. `.first()` uses one source,
  `.all()` uses all sources. `insertTo` ignores matches.
- Moving a node into itself, or moving the root, throws and leaves the data unchanged.
- `overwritePolicy: 'overwrite' | 'skip' | 'error'` controls occupied object slots.
- Structural operators never re-visit nodes they just inserted.

## Immutability and copy-on-write

| Need | Use |
| --- | --- |
| Edit data you own | default (in place) |
| Keep the input untouched | `new JsnqPipeline(data, { immutable: true })`; read `.data` |
| Keep unchanged rows `===` the originals (stores, memoization) | `tryFastPipelineMutation(current, [where(...), update(...)])` |

`immutable` deep-clones everything: unmatched rows become new objects too. The copy-on-write
helpers return a new outer array and new objects only for matched rows, or `undefined` when the
shape is not eligible (non-array root, deep `@`, structural actions, ...), in which case run a
normal pipeline. `first()` on an immutable pipeline returns the mutated value but does not update
`pipeline.data`; use `all()`.

## Reading and writing by path (no pipeline)

```ts
import { readJsonPath, writeJsonPath, deleteJsonPath, hasJsonPath } from '@adsq/jsnq/data-engine';

const state: Record<string, unknown> = {};

writeJsonPath(state, 'workspace.pages.0.title', 'Home'); // creates containers, MUTATES `state`
readJsonPath(state, 'workspace.pages[0].title'); // => 'Home'
deleteJsonPath(state, 'workspace.pages.0.title');
hasJsonPath(state, 'workspace.pages.0.title'); // => false
```

Writes return a result (`kind`, `previous`, `next`, `changed`, `inserted`, `affectedPaths`, ...).
A container of the wrong kind on the way is replaced. `''` reads the root.

## TypeScript

- `JsnqPipeline<TData>` needs JSON-like data: use `type` aliases with concrete fields, not
  `interface` or `unknown`.
- `Path<T>` and `PathValue<T, P>` type paths. Operators also accept any `string` through a loose
  overload, so typos are not rejected by the operators themselves: check with
  `const p: Path<T> = '...'` or `'...' satisfies Path<T>`. Index segments are `users.0.name` or
  `users.[0].name` in the typed union.
- `all()` types `node.data` as the root type; narrow it, or use `first<T>()`.
- Function updaters on untyped paths need explicit parameter types: `(current: unknown) => ...`.

## Safety

`__proto__`, `prototype` and `constructor` path segments throw `Unsafe path segment`. Do not
deep-merge untrusted parsed JSON with `mergeUpdate(..., { deep: true })` without stripping
`__proto__` keys. Reads use plain property access (`toString` resolves); use `hasJsonPath` for
own-key checks.

## CommonJS

Root named exports work with `require('@adsq/jsnq')`. Subpath modules export `{ default }`:
`require('@adsq/jsnq/operators/where').default`.

## Checklist when writing code against jsnq

- Start every mutation pipeline with a `where()`.
- Run one terminal call, then read `pipeline.data`.
- Choose the mode on purpose: in place, `immutable: true`, or copy-on-write for identity.
- Give object targets an explicit string `key`; give array targets an optional numeric index.
- Use `$` paths (with `*`) for `*Matches` / `*All` targets you can name.
- Import operators from `@adsq/jsnq/operators/<name>` and data-engine functions from
  `@adsq/jsnq/data-engine`. Do not import from `dist/` or invent deep paths.
- Do not vendor or fork the engine; depend on the package.
