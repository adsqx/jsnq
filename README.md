# @adsq/jsnq

[![npm](https://img.shields.io/npm/v/@adsq/jsnq)](https://www.npmjs.com/package/@adsq/jsnq)
[![license](https://img.shields.io/npm/l/@adsq/jsnq)](./LICENSE)

**A JSON pipeline engine: find nodes with `where`, change them with `update` / `mergeUpdate` /
`deleteKey`, restructure with `moveTo` / `copyTo` / `insert`.** It works on flat arrays and on deeply
nested trees, can edit in place, on a clone, or copy-on-write, ships typed paths, and has **zero
runtime dependencies** and no framework assumptions.

It is the query and mutation engine behind
[`@adsq/solid-signal-store`](https://github.com/adsqx/solid-signal-store) and
[`@adsq/angular-signal-store`](https://github.com/adsqx/angular-signal-store).

## Contents

- [Why jsnq](#why-jsnq)
- [Install](#install)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Operator reference](#operator-reference)
- [Data engine](#data-engine)
- [TypeScript path typing](#typescript-path-typing)
- [Entry points and tree-shaking](#entry-points-and-tree-shaking)
- [Safety](#safety)
- [Performance](#performance)
- [FAQ](#faq)
- [Compatibility](#compatibility)
- [Used by](#used-by)
- [Examples and docs](#examples-and-docs)
- [Use with AI coding agents](#use-with-ai-coding-agents)
- [Verify](#verify)
- [License](#license)

## Why jsnq

**Versus hand-written immutable updates.** Spreading `{ ...user, profile: { ...user.profile, name } }`
is fine for one known location. It stops being fine for "every node matching X, at any depth",
for moving an element from one list to another, or for keeping the same rule in several places.
With jsnq the rule is a value you can build, pass around and test:

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

const menu = { id: 'root', items: [{ id: 'a', hidden: true, items: [{ id: 'b', hidden: true }] }] };

// Clear the `hidden` flag on every node that has it, however deep.
const clear = new JsnqPipeline(menu, { immutable: true }).pipe(where('hidden', '===', true), update('hidden', false));
clear.count(); // => 2
JSON.stringify(clear.data); // => '{"id":"root","items":[{"id":"a","hidden":false,"items":[{"id":"b","hidden":false}]}]}'
```

**Versus lodash-style paths.** `get` / `set` / `unset` address one location you already know. jsnq
adds the search (`where`, including deep `fields@id` criteria over nested arrays) and the
structural operations (`moveTo`, `copyTo`, `insert`, `deleteElement`), and it also exposes the path
layer on its own as [`@adsq/jsnq/data-engine`](./docs/data-engine.md).

**What it is not.** It is not a query language such as JSONPath or jq, it does not validate schemas,
and it is not faster than carefully hand-written loops (see [Performance](#performance) for the
measured gap). You pay a little speed for one declarative, tested, consistent set of semantics.

## Install

```sh
npm install @adsq/jsnq
# or
bun add @adsq/jsnq
```

Ships ESM and CommonJS builds plus type declarations. No dependencies.

## Quick start

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

const users = [
  { id: 1, name: 'Ann', active: true, score: 10 },
  { id: 2, name: 'Bob', active: false, score: 20 },
  { id: 3, name: 'Cy', active: true, score: 30 },
];

const pipeline = new JsnqPipeline(users, { immutable: true })
  .pipe(where('active', '===', true), update('score', (n: number) => n + 1));

pipeline.count(); // => 2
(pipeline.data as typeof users).map((u) => u.score); // => [11, 20, 31]
users.map((u) => u.score); // => [10, 20, 30]
```

`pipe()` only describes the work. `all()`, `first()` or `count()` executes it, and the result is on
`pipeline.data`. Read-only queries use the same API:

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';

const users = [{ id: 1, name: 'Ann', active: true }, { id: 2, name: 'Bob', active: false }];
const active = new JsnqPipeline(users).pipe(where('active', '===', true));

active.first(); // => { id: 1, name: 'Ann', active: true }
active.count(); // => 1
active.all().map((node) => node.path); // => [['0']]
```

## Concepts

### Pipeline

`new JsnqPipeline(data, options?).pipe(...operators)` builds a description; a terminal call runs it.

- `where(path, operator, value)` adds a **criterion**. All criteria are AND-combined.
- Every other operator adds an **action** applied to each match, in the order written.
- **A match is any node in the tree** that satisfies the criteria: the root, array elements, nested
  objects, down to `maxDepth` (default `10`). `where('id', '===', 2)` finds every object with `id` 2,
  not just rows of a top-level array. With no `where()`, every node matches.
- Terminal calls: `all()` returns result nodes (`data`, `path`, `depth`), `first()` returns the first
  matched value or `null`, `count()` returns the number of matches. `getStats()` reports counters
  and warnings; `dryRun()` plans without writing.
- **Each terminal call executes the actions again**, so call one, then read `pipeline.data`.

### Operators

Seventeen small operators, each its own module: `where`; `update`, `replace`, `mergeUpdate`,
`deleteKey`; `deleteElement`, `insert`; `insertTo`, `moveTo`, `copyTo`; `moveToMatches`,
`copyToMatches`, `moveToAll`, `copyToAll`, `moveToMatchesOverwrite`, and the aliases
`moveToFirstTarget` / `copyToFirstTarget`. See the [table below](#operator-reference) and
[docs/operators.md](./docs/operators.md).

### Mutation modes

| Mode | Enable with | Input | What is cloned | Use it for |
| --- | --- | --- | --- | --- |
| In place | default | mutated | nothing | data you own |
| Immutable | `{ immutable: true }` | untouched | the whole input, once | simple safe updates |
| Immutable, lazy | `{ immutable: 'auto' }` | untouched | the whole input, only when the pipeline has actions | one path for reads and writes |
| Copy-on-write | [`tryFastPipelineMutation`](./docs/pipeline.md#copy-on-write-host-helpers) | untouched | matched items only; unmatched items keep their identity | state stores, `===` change detection |

`immutable` gives value semantics but no structural sharing: even unmatched rows become new objects.
The copy-on-write helpers return a new outer array and new objects only for matched rows, and hand
back the original array when nothing matched. They return `undefined` for shapes they cannot prove
equivalent to a normal run (see [docs/pipeline.md](./docs/pipeline.md#copy-on-write-host-helpers)),
and the caller falls back to a pipeline.

### Paths, `@`, `$`, `*`

One path syntax everywhere: `a.b`, `users.0.name`, `users[0].name`, `settings["display.name"]`,
`a\.b`. Three special forms:

- **`fields@id`** (in `where`): search the array at `fields` and every nested `fields` array below it.
- **`$.baskets[0].items`** (target selectors of `moveToMatches`, `copyToAll`, ...): absolute path from
  the root. **`$.baskets.*.items`**: `*` matches any single key or index.
- Without `$`, a target selector is a criterion: the nodes where it holds are the targets.

Full rules, result nodes and pitfalls: [docs/paths.md](./docs/paths.md).

## Operator reference

| Operator | Signature | One-line semantics |
| --- | --- | --- |
| `where` | `(path, operator, value)` | Keep nodes whose value at `path` satisfies `operator`; AND-combined. |
| `update` | `(path, valueOrFn)` | Write `path` on each match, creating missing containers; `fn(current, node)`. |
| `replace` | `(path, valueOrFn)` | Same write as `update`; counted separately in stats. |
| `mergeUpdate` | `(path, patch, { deep? })` | Shallow or deep merge of an object into the value at `path`. |
| `deleteKey` | `(path)` | Delete the key at `path` on each match (splices an array index). |
| `deleteElement` | `()` | Remove each matched node from its parent. |
| `insert` | `(data, position = 'inside', keyOrOpts?)` | Insert `data` inside, before or after each match. |
| `insertTo` | `(path, data, modeOrOpts = 'inside', key?)` | Insert at a path; needs no match; runs once. |
| `moveTo` | `(path, modeOrOpts = 'inside', key?)` | Move each match to a path. |
| `copyTo` | `(path, modeOrOpts = 'inside', key?)` | Deep-copy each match to a path. |
| `moveToMatches` | `(targetKey, targetOperator, targetValue, mode = 'inside', key?)` | Move all sources into the first selected target. |
| `copyToMatches` | same | Copy all sources into the first selected target. |
| `moveToAll` | same | Move sources into every selected target (extra targets get clones). |
| `copyToAll` | same | Copy sources into every selected target. |
| `moveToMatchesOverwrite` | `(targetKey, targetOperator, targetValue, overwriteKey)` | Move sources into `target[overwriteKey]`, overwriting the slot. |
| `moveToFirstTarget`, `copyToFirstTarget` | same as `*Matches` | Aliases of `moveToMatches` / `copyToMatches`. |

Built-in comparison operators for `where`: `==`, `===`, `!=`, `!==`, `>`, `>=`, `<`, `<=`, `includes`,
`!includes`, `startsWith`, `endsWith`, `regex` (`RegExp`, `'pattern'` or `'/pattern/flags'`), `isArray`,
`isObject`. Add your own with `registerOperator(name, fn)`. Positions are `'inside'`, `'before'`,
`'after'`. Inserting into an object needs an explicit string `key`. Details, keys, overwrite policy and
failure behaviour: [docs/operators.md](./docs/operators.md).

## Data engine

`@adsq/jsnq/data-engine` is the path layer on its own, for hosts that read and write by path without
a pipeline. It **mutates the object you pass**. Full API: [docs/data-engine.md](./docs/data-engine.md).

| Function | Purpose |
| --- | --- |
| `readJsonPath(root, pathOrPlan)` | Value at the path, or `undefined`. |
| `hasJsonPath(root, pathOrPlan)` | Own-key existence check. |
| `writeJsonPath(root, pathOrPlan, value)` | Set a value, creating missing containers; returns a mutation result. |
| `writeJsonPathValue(root, pathOrPlan, value)` | Same write, returns a boolean (no result allocation). |
| `deleteJsonPath(root, pathOrPlan)` | Delete a key or splice an array index; returns a mutation result. |
| `createJsonPathPlan(path)` | Parse once (cached), reuse for many reads/writes. |
| `getJsonAffectedPaths(pathOrPlan, mode)` | `'exact'` path, or `'branch'` (path plus ancestors). |
| `cloneJsonData(value)` | Deep clone of plain JSON-like data. |
| `JsonDataCursor` | Speeds up repeated writes into one subtree. |

```ts
import { writeJsonPath, readJsonPath, deleteJsonPath } from '@adsq/jsnq/data-engine';

const state: Record<string, unknown> = {};
writeJsonPath(state, 'workspace.pages.0.title', 'Home').affectedPaths; // => ['workspace.pages.0.title']
readJsonPath(state, 'workspace.pages[0].title'); // => 'Home'
deleteJsonPath(state, 'workspace.pages.0.title').kind; // => 'delete'
```

## TypeScript path typing

`JsnqPipeline<TData>` requires JSON-like data. Declare the shape with a `type` alias (interfaces
and `unknown` fields do not satisfy `JsonLike`). Then `Path<T>` is the union of valid paths and
`PathValue<T, P>` the type at a path:

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import type { Path, PathValue } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

type Data = { users: Array<{ id: number; stats: { logins: number } }> };

const logins = 'users.0.stats.logins' satisfies Path<Data>;
type Logins = PathValue<Data, typeof logins>; // number

const pipeline = new JsnqPipeline<Data>({ users: [{ id: 1, stats: { logins: 2 } }] }, { immutable: true })
  .pipe(where(logins, '>=', 1), update(logins, (current) => current + 1)); // `current` is a number
pipeline.count(); // => 1
```

What the types do, exactly:

- A path that is in `Path<T>` gets **inferred value types**: the `update` callback's `current` and
  the accepted `where` value are typed from the path.
- A path that is **not** in `Path<T>` is still accepted by a looser overload (typed as `string`), so
  operators alone do not reject typos. To have the compiler check a path, annotate it:
  `const p: Path<Data> = '...'` or `'...' satisfies Path<Data>`.
- Index segments in `Path<T>` are `0` / `[0]` after a dot (`users.0.name`, `users.[0].name`);
  `BracketPath<T>` uses `[0]`. `users[0].name` is valid at runtime but is not in either union.
- The `key` argument of `insertTo` / `moveTo` / `copyTo` is typed `number` for array targets and
  `string` for object targets when the path is typed; the looser overload accepts either, so this is
  a hint rather than a guarantee. The runtime check (an object target needs a string key) always applies.
- `all()` types `node.data` as the root type. Narrow it (`node.data as unknown as Row`) or use
  the generic `first<Row>()`.

## Entry points and tree-shaking

| Import | Contains |
| --- | --- |
| `@adsq/jsnq` | Everything: `JsnqPipeline`, `PipelineWrapper`, all operators, data engine, types, host helpers. |
| `@adsq/jsnq/operators/<name>` | One operator (default export), e.g. `@adsq/jsnq/operators/where`. |
| `@adsq/jsnq/core/<module>` | One engine module, e.g. `core/pipeline` (default export `JsnqPipeline`), `core/types`, `core/match`. |
| `@adsq/jsnq/data-engine` | The path layer only. |

`import` resolves to ESM in `dist/`, `require` to CommonJS in `dist-cjs/`; `sideEffects` is `false`.
Importing an operator does not pull in the pipeline: a pipeline, compiled predicate or path plan is
only created when the matching API is called. In CommonJS the subpath modules export
`{ default }`:

```js
const { JsnqPipeline, where } = require('@adsq/jsnq');        // named exports from the root
const whereOnly = require('@adsq/jsnq/operators/where').default; // subpath: use .default
```

Measured from the built ESM with `bun build --minify --target=browser` (gzip level 9, brotli default):

| Entry | Minified | Gzip | Brotli |
| --- | ---: | ---: | ---: |
| `@adsq/jsnq` (everything) | 55.1 kB | 16.3 kB | 14.7 kB |
| `JsnqPipeline` + `where` + `update` | 44.8 kB | 13.3 kB | 12.0 kB |
| `data-engine` alone | 8.2 kB | 3.0 kB | 2.7 kB |
| `operators/where` alone | 3.3 kB | 1.4 kB | 1.2 kB |

The pipeline class carries the fast paths, so any pipeline usage costs about 45 kB minified. If
you only need path reads and writes, import `@adsq/jsnq/data-engine`.

## Safety

The path layer rejects the three prototype-pollution segments. `__proto__`, `prototype` and
`constructor` inside a string path throw `Unsafe path segment in '<path>'` when the path is compiled:
in `readJsonPath` / `writeJsonPath` / `deleteJsonPath` / `hasJsonPath`, in action keys (`update`,
`replace`, `mergeUpdate`, `deleteKey`), in `where()` paths and in insert/move/copy positions.
`getJsonBySegments`, which takes raw segments, returns `undefined` for them. `cloneJsonData` keeps
an own `__proto__` key from `JSON.parse` as plain data. This is covered by
`test/jsnq-prototype-guard.test.ts` and the data-engine suite.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import update from '@adsq/jsnq/operators/update';

try {
  new JsnqPipeline({}).pipe(update('__proto__.polluted', true)).all();
} catch (error) {
  (error as Error).message; // => "Unsafe path segment in '__proto__.polluted'"
}
({} as { polluted?: boolean }).polluted; // => undefined
```

Limits, as of 0.1.4:

- The guard covers **paths**. A deep merge (`mergeUpdate(path, patch, { deep: true })`) of a patch
  that has an own `__proto__` key (possible only through `JSON.parse`) sets the prototype of the
  merged object. It does not touch `Object.prototype`, but do not deep-merge untrusted patches
  without stripping such keys.
- Reads use plain property access, so `readJsonPath({}, 'toString')` returns the inherited function.
  Use `hasJsonPath` for "is this an own key".
- Writes replace a value that is not a container of the expected kind (`a.b` on `{ a: 1 }` turns
  `a` into `{ b }`).
- A legitimate data key named `__proto__`, `prototype` or `constructor` cannot be addressed by a
  string path; the guard refuses it.
- jsnq validates structure, not data: it does not check schemas or types of your values.

## Performance

Numbers below were measured on this repository at 0.1.4, not estimated.

<!-- PERF:START -->
<!-- PERF:END -->

## FAQ

**My update touched more nodes than I expected.** `where()` matches nodes at any depth, and a
pipeline with no `where()` matches every node including the root. Add a criterion, or lower
`maxDepth`. See [paths.md](./docs/paths.md#what-a-match-is).

**Why did calling `all()` and then `count()` apply my update twice?** Each terminal call executes the
pipeline. Call one and read `pipeline.data`; use `dryRun()` to inspect without applying.

**Does it mutate my data?** By default yes, in place. Use `{ immutable: true }` for a private clone,
or the copy-on-write helpers to keep identity for unchanged rows. `first()` on an immutable pipeline
returns the mutated value but leaves `pipeline.data` unchanged; use `all()` when you need `data`.

**How do I update one known path?** `writeJsonPath(obj, 'a.b.c', value)` from
`@adsq/jsnq/data-engine` (in place), or `where()` on a unique key plus `update`.

**Why does inserting into an object throw "explicit string 'key' is required"?** An object has no
position to append to. Pass a key: `copyTo('archive', 'inside', 'card-1')`. Arrays take an optional
numeric index instead. The `*Matches` / `*All` operators derive the key from the source when you omit it.

**`moveToMatches('items', 'isArray', true)` moved things into the wrong place.** A relative selector
targets the nodes that satisfy the criterion, here the *objects that have an `items` array*. Select
the array itself with `'length'` or a `$` path: `moveToMatches('$.baskets.0.items', '===', true)`.

**TypeScript accepts a misspelled path.** Operators fall back to a loose `string` overload. Check paths
with `Path<T>`; see [TypeScript path typing](#typescript-path-typing).

**TypeScript says `Type ... does not satisfy the constraint 'JsonLike'`.** Use `type` aliases with
concrete field types. Interfaces have no implicit index signature and `unknown` is not JSON-like.

**Is `@adsq/jsnq/operators/where` a function under `require()`?** No, it is `{ default }`; use
`.default` or the named exports of the root entry.

**Does it work under a strict CSP?** Yes. Hot paths compile small predicates with `new Function`;
when that is blocked (checked by making `Function` throw) the engine falls back to its interpreter with identical results, only slower.

**Can I plug in my own comparison?** `registerOperator('isEven', (actual, expected) => ...)`, then
`where('n', 'isEven', undefined)`. It is global to the process.

## Compatibility

| | Status |
| --- | --- |
| Node.js | ESM import and CommonJS `require` verified on Node 22.22. |
| Bun | Test suite, benchmarks and examples run on Bun 1.3.11. |
| Browsers / bundlers | Output is ES2022 with no Node-specific APIs (`performance` and `structuredClone` are feature-tested). Use any bundler that honours `exports`. Not browser-tested here. |
| TypeScript | Declarations verified with `moduleResolution: bundler` on TS 5.0 and 5.9, and `node` (node10) on TS 4.7. See the known issue below. |

**Known typing issue.** Under `moduleResolution: node16` / `nodenext`, six generated declarations
(`moveToMatches`, `copyToMatches`, `moveToAll`, `copyToAll`, `moveToFirstTarget`,
`copyToFirstTarget`) and `PipelineWrapper.stats` contain an unresolvable relative import, so with
`skipLibCheck: true` they silently degrade to `any`. CommonJS TypeScript projects using node16
resolution also hit TS1479 because the declarations are ESM only. `bundler` resolution is unaffected.

## Used by

- [`@adsq/solid-signal-store`](https://github.com/adsqx/solid-signal-store): Solid store on a callable
  nested proxy. Its optional JSNQ entry exposes `mutate`, `$query` and `$liveQuery` on array paths and
  commits through the copy-on-write helpers.
- [`@adsq/angular-signal-store`](https://github.com/adsqx/angular-signal-store): the same idea for
  Angular signals; it also shares the data engine for path reads and writes.

Both declare `@adsq/jsnq` as a peer dependency.

## Examples and docs

- [`examples/`](./examples): six short runnable programs (`bun run examples`).
- [`docs/operators.md`](./docs/operators.md): every operator in detail.
- [`docs/paths.md`](./docs/paths.md): path syntax, matching, `@` / `$` / `*`.
- [`docs/pipeline.md`](./docs/pipeline.md): options, stats, mutation modes, copy-on-write helpers.
- [`docs/data-engine.md`](./docs/data-engine.md): the path layer.
- [`AGENTS.md`](./AGENTS.md) and [`SKILL.md`](./SKILL.md): notes for AI coding agents.

## Use with AI coding agents

The package ships a [`SKILL.md`](./SKILL.md) in the [Agent Skills](https://agentskills.io) format.
Install it so an agent uses jsnq correctly instead of guessing:

```sh
# this project only
mkdir -p .claude/skills/jsnq
cp node_modules/@adsq/jsnq/SKILL.md .claude/skills/jsnq/

# or for every project
mkdir -p ~/.claude/skills/jsnq
cp node_modules/@adsq/jsnq/SKILL.md ~/.claude/skills/jsnq/
```

Agents that do not read `.claude/skills/` can be pointed at `node_modules/@adsq/jsnq/SKILL.md`.

## Verify

```sh
bun install
bun run typecheck
bun run test          # types, units, fast-path parity, data engine, edge cases, structural
                      # safety, vs-native parity, prototype guard, benchmark checks
bun run examples      # the six examples assert their own output
npm run build
npm pack --dry-run    # the tarball contains dist/, dist-cjs/, README, LICENSE, SKILL.md, AGENTS.md
```

## License

MIT
