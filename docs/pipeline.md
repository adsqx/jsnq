# Pipeline API

`JsnqPipeline<TData>` is the engine. This page covers construction, options, terminal methods,
statistics, the three mutation modes, `PipelineWrapper`, and the copy-on-write helpers used by
state stores.

- [Constructing a pipeline](#constructing-a-pipeline)
- [Options](#options)
- [Methods](#methods)
- [Statistics and warnings](#statistics-and-warnings)
- [Mutation modes](#mutation-modes)
- [`PipelineWrapper`](#pipelinewrapper)
- [Copy-on-write host helpers](#copy-on-write-host-helpers)
- [Production settings](#production-settings)
- [Other exports](#other-exports)

## Constructing a pipeline

```ts
import { JsnqPipeline } from '@adsq/jsnq';
// or, importing only what you use:
// import JsnqPipeline from '@adsq/jsnq/core/pipeline';
import where from '@adsq/jsnq/operators/where';

const pipeline = new JsnqPipeline([{ id: 1 }], { immutable: true }).pipe(where('id', '===', 2));
pipeline.count(); // => 0
```

`new JsnqPipeline(data, options?)`. `data` must be JSON-like (`JsonLike`: primitives, arrays and
plain objects with JSON-like values). Interfaces and `unknown`/`Record<string, unknown>` fields do
not satisfy that type; use `type` aliases with concrete field types.

The pipeline object itself is cheap and immutable: `pipe()`, `immutable()` and `dryRun()` each return a
new pipeline that shares the same `data`.

## Options

All options are optional. Defaults are the values used when the option is omitted.

| Option | Default | Effect |
| --- | --- | --- |
| `immutable` | `false` | `true`: deep-clone the input once before running, so the input is never touched; result on `.data`. `'auto'`: clone only when the pipeline has actions. |
| `dryRun` | `false` | Plan and count without writing (stats and `operations` are still filled). |
| `maxDepth` | `10` | How many levels below the root are visited. Deeper nodes never match. |
| `includeArrays` | `true` | Descend into arrays. |
| `includeObjects` | `true` | Descend into plain objects. |
| `limit` | none | Stop after this many matches. |
| `earlyTermination` | `false` | Same as `limit: 1` when no `limit` is given (`first()` sets it). |
| `returnPaths` | `true` | Fill `path` on each result node. `false` avoids allocating path arrays. |
| `buildMeta` | `true` | Set `false` on a read-only pipeline (no actions) to skip building result `path`s altogether. Parent links are always built on demand for actions that need them. |
| `trackOperations` | `true` | Record one string per applied action in `getStats().operations`. `false` skips the allocation. |
| `strictPathsWarn` | `false` | Add a warning whenever a write creates a missing path, or a `deleteKey` targets a missing key. |
| `operatorsStrict` | none | Unknown comparison operator: `'warn'` adds a warning once per operator, `'throw'` throws. Default: never matches, silently. |
| `overwritePolicy` | `'overwrite'` | Occupied object slot on structural inserts: `'overwrite'`, `'skip'`, or `'error'`. |
| `warnOnOverwrite` | `true` | Record a warning when a slot is overwritten or skipped. |
| `objectOrderWarning` | `true` | Warn that `before`/`after` on object members has no stable order. |
| `arrayMergeStrategy` | `'replace'` | Arrays inside `mergeUpdate(..., { deep: true })`: `'replace'`, `'concat'`, `'merge-by-key'`. |
| `arrayMergeKey` | `'id'` | Key (or `(item) => key` function) for `'merge-by-key'`. |

`overwritePolicy` and the array-merge options are described in [operators.md](./operators.md).

## Methods

| Member | Returns | Notes |
| --- | --- | --- |
| `pipe(...operators)` / `pipeline(...operators)` | new pipeline | Adds criteria and actions. Nothing runs yet. |
| `all()` | `SearchResultNode[]` | Executes; every match, with actions applied. |
| `first<T>()` | `T \| null` | Executes with early termination; returns the first matched **value** (not a node). |
| `count()` | `number` | Executes; number of matches. |
| `data` | `TData` | The working data: the mutated input, or the clone when `immutable` applied. |
| `getStats()` | `PipelineStats` | Counters and warnings of the **last** execution. |
| `immutable(mode = true)` | new pipeline | Same as passing `immutable` in the options. |
| `dryRun(enabled = true)` | new pipeline | Same as passing `dryRun`. |
| `with({ data?, options?, criteria?, actions? })` | new pipeline | Low-level copy used by operators. |
| `clone()` | new pipeline | Copy sharing the same `data` reference. |

Things worth knowing:

- **Each terminal call executes the actions again.** `all()` then `count()` applies a mutating
  pipeline twice. Call one terminal method, then read `data`.
- `first()` is an early-terminated execution of the same pipeline: like `all()`, it leaves the
  (possibly cloned) result on `data` and the counters on `getStats()`.
- With `immutable: true` the clone happens on the first execution even if nothing matches.
- `all()` nodes are typed `SearchResultNode<TData>`; narrow `node.data` yourself.

## Statistics and warnings

`getStats()` returns a copy of the counters for the most recent execution:

| Field | Meaning |
| --- | --- |
| `searchTime` | Milliseconds spent in the execution. |
| `nodesVisited`, `maxDepth`, `resultsFound` | Traversal size, deepest level reached, number of matches. |
| `updates`, `replaces`, `mergeUpdates`, `deletedKeys`, `deletedElements` | Applied value/element actions. |
| `inserted`, `moved`, `copied` | Applied structural actions. |
| `warnings` | Human-readable strings: implicit path creation, overwrites, skipped writes, unknown operators. |
| `operations` | One label per applied action, e.g. `update profile.name`. Empty when `trackOperations` is `false`. |

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';
import insertTo from '@adsq/jsnq/operators/insertTo';

const pipeline = new JsnqPipeline({ users: [{ id: 1, name: 'Ann' }] }, { strictPathsWarn: true }).pipe(
  where('id', '===', 1),
  update('profile.age', 30),
  insertTo('audit', { note: 'edited' }, 'inside', 'last'),
);
pipeline.all();

const stats = pipeline.getStats();
stats.updates; // => 1
stats.inserted; // => 1
stats.operations; // => ['update profile.age', 'insert_to audit inside last']
stats.warnings; // => ["update: path 'profile.age' did not exist; created implicitly", "insert_to: target path 'audit' did not exist; created implicitly"]
```

`dryRun()` fills the same counters and labels without writing anything:

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import deleteElement from '@adsq/jsnq/operators/deleteElement';

const rows = [{ id: 1, stale: true }, { id: 2, stale: false }];
const plan = new JsnqPipeline(rows).dryRun().pipe(where('stale', '===', true), deleteElement());
plan.all();
plan.getStats().deletedElements; // => 1
rows.length; // => 2
```

## Mutation modes

| Mode | Enable with | Input after the call | What is cloned | Use it for |
| --- | --- | --- | --- | --- |
| In place | default | mutated | nothing | data you own; scripts; server-side transforms |
| Immutable | `{ immutable: true }` | untouched | the **entire** input, once | simple safe updates where sharing does not matter |
| Immutable, lazy | `{ immutable: 'auto' }` | untouched | the entire input, only if the pipeline has actions | one code path for reads and writes |
| Copy-on-write | [`tryFastPipelineMutation`](#copy-on-write-host-helpers) | untouched | matched items only; everything else keeps its identity | state stores, `===` change detection |

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

const users = [{ id: 1, name: 'Ann' }, { id: 2, name: 'Bob' }];

const lazy = new JsnqPipeline(users).immutable('auto').pipe(where('id', '===', 2), update('name', 'Bo'));
lazy.all();
(lazy.data as typeof users)[1].name; // => 'Bo'
users[1].name; // => 'Bob'

// A read-only pipeline never clones under 'auto': data keeps the original identity.
const read = new JsnqPipeline(users).immutable('auto').pipe(where('id', '===', 2));
read.all();
read.data === users; // => true
```

`immutable: true` and `'auto'` give value semantics but **do not preserve structural sharing**: even
unmatched rows are new objects. When identity matters (memoization, `===` checks, UI change
detection) use the copy-on-write helpers below.

## `PipelineWrapper`

A small convenience for hosts that always want to work on a private copy. It deep-clones the input
on construction (`autoClone`, default `true`), accepts operators through `pipeline(...)`, and
exposes `execute(mode)`, `data` and `stats`.

```ts
import { PipelineWrapper } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

const scores = [{ id: 1, score: 1 }, { id: 2, score: 2 }];
const wrapper = new PipelineWrapper(scores);

wrapper.pipeline(where('id', '===', 2), update('score', 20)).execute('all');
wrapper.data; // => [{ id: 1, score: 1 }, { id: 2, score: 20 }]
scores[1].score; // => 2
wrapper.stats.updates; // => 1
```

`execute(mode)` accepts `'all'` (default), `'first'` or `'count'`, and re-runs the actions on every call.

## Copy-on-write host helpers

State stores want a **new** value only where something changed, so that unchanged branches keep
their identity. These helpers compute that directly. They are what
[`@adsq/solid-signal-store`](https://github.com/adsqx/solid-signal-store) and
[`@adsq/angular-signal-store`](https://github.com/adsqx/angular-signal-store) call for
`store.list.mutate(where(...), update(...))`.

### `tryFastMutation(current, operators, options?)`

The whole cascade in one call, with the operators analysed once: `tryFastPipelineMutation`, then the
[structural shortcuts](#structural-shortcuts), then the deep sugar patch (`where('a.b.c', ...)` +
`update({ ...patch })`). Same result shape; `undefined` when none applies, so run a pipeline. This is
the entry both signal stores use.

### `tryFastPipelineMutation(current, operators, options?)`

Takes the same operator list you would `pipe()`. Returns
`{ value, matched, mutations, affectedPaths } | undefined`.

- `value`: a new outer array where matched items are new objects and every other item is the same
  reference as in `current`. With no match, `value === current`.
- `matched` / `mutations`: matched items, and applied value actions.
- `affectedPaths`: changed paths such as `['0', '0.score']` for precise wake-ups, or `null` when
  the shape has no exact paths or `{ collectAffectedPaths: false }` is set.
- Returns `undefined` whenever the shape is not one it can prove equivalent to a normal execution.
  The caller then runs a regular pipeline. Eligible shape: an **array root**, at least one `where()`,
  no deep `@` criteria, only value actions (`update`, `replace`, `mergeUpdate`, `deleteKey`) with
  string paths, no pipeline options set by operators, and no nested value that could also match a
  criterion.

Matched items are shallow-cloned when every action targets a single key, and deep-cloned otherwise.

```ts
import { tryFastPipelineMutation } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

const rows = [
  { id: 1, active: true, score: 1 },
  { id: 2, active: false, score: 2 },
];

const result = tryFastPipelineMutation(rows, [where('active', '===', true), update('score', 9)]);
result?.value[0].score; // => 9
result?.value[1] === rows[1]; // => true
result?.affectedPaths; // => ['0', '0.score']
rows[0].score; // => 1

// Not eligible (root is an object): undefined, so fall back to a pipeline.
tryFastPipelineMutation({ rows }, [where('active', '===', true), update('score', 9)]); // => undefined
```

### Structural shortcuts

`tryFastStructuralMutation(current, collectPipelineIntent(operators))` covers three criteria-less,
single-action shapes with the same copy-on-write contract: `insert` into an array root,
`deleteKey` over an array of flat objects, and `insertTo(path, data)` appending to an existing array.
`applyInsertToInsideArrayCow(current, path, data)` is the last one on its own: it copies only the
spine from the root to the target array. All return `undefined` when the shape does not fit.

```ts
import { tryFastStructuralMutation, collectPipelineIntent } from '@adsq/jsnq';
import insertTo from '@adsq/jsnq/operators/insertTo';

const state = { list: [1, 2], other: { z: 1 } };
const next = tryFastStructuralMutation(state, collectPipelineIntent([insertTo('list', 3)]));

next?.value; // => { list: [1, 2, 3], other: { z: 1 } }
(next?.value as typeof state).other === state.other; // => true
state.list.length; // => 2
```

`applyDeepSugarPatch` and `isDeepSugarAction` support the store bridges' `update({ patch })` sugar and
are exported for those hosts; application code does not normally need them.

## Production settings

Two options remove diagnostic work when you only need the resulting data:

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

const rows = Array.from({ length: 1000 }, (_, id) => ({ id, active: id % 2 === 0, score: 0 }));

const pipeline = new JsnqPipeline(rows, { returnPaths: false, trackOperations: false })
  .pipe(where('active', '===', true), update('score', 1));
pipeline.count(); // => 500
pipeline.getStats().operations; // => []
```

`returnPaths: false` avoids one path array per match; `trackOperations: false` avoids one label
string per applied action. The store bridges set both outside development diagnostics.
See [Performance in the README](../README.md#performance) for measured numbers.

## Other exports

| Export | Purpose |
| --- | --- |
| `registerOperator(name, fn)` | Add a global comparison operator. |
| `setPathCacheLimit(n)` | Bound the shared path-plan cache (default 5000 plans, minimum 16). |
| `buildPath(...segments)` | Build a path string from segments, quoting where needed. |
| Types: `Path`, `PathValue`, `BracketPath`, `OperatorFor`, `KeyFor`, `SearchOptions`, `PipelineStats`, `SearchResultNode`, `JsonLike`, `JsonOperator`, `PipelineLike`, ... | See [TypeScript path typing](../README.md#typescript-path-typing). |
| Everything in [`data-engine`](./data-engine.md) | Also re-exported from the root entry. |

Every module under `core/` is reachable as `@adsq/jsnq/core/<name>` (for example
`@adsq/jsnq/core/pipeline` for the default-exported class, `@adsq/jsnq/core/match`,
`@adsq/jsnq/core/types`). Those are advanced integration points: they are public, but most
applications only need the root entry and the operators.
