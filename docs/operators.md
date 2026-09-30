# Operator reference

Every operator is a default export of its own module, so it can be imported alone:

```ts
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';
```

The root entry (`@adsq/jsnq`) re-exports all of them as named exports.

- [How operators compose](#how-operators-compose)
- [Summary table](#summary-table)
- [Filtering: `where`](#filtering-where)
- [Value operators](#value-operators): `update`, `replace`, `mergeUpdate`, `deleteKey`
- [Element operators](#element-operators): `deleteElement`, `insert`
- [Path-targeted structural operators](#path-targeted-structural-operators): `insertTo`, `moveTo`, `copyTo`
- [Match-targeted structural operators](#match-targeted-structural-operators): `moveToMatches`, `copyToMatches`, `moveToAll`, `copyToAll`, `moveToMatchesOverwrite`
- [Positions, keys and overwrite policy](#positions-keys-and-overwrite-policy)
- [Stable match sets and failure behaviour](#stable-match-sets-and-failure-behaviour)

## How operators compose

An operator is a function `(pipeline) => pipeline`. `pipe(...operators)` applies them left to right
and returns a new pipeline; nothing runs yet.

- `where()` adds a **criterion**. All criteria are AND-combined, whatever their order.
- Every other operator adds an **action**. Actions run against each match, in the order written.
- A terminal call (`all()`, `first()`, `count()`) executes the pipeline.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

const rows = [{ id: 1, score: 10, active: true }, { id: 2, score: 20, active: false }];

// Criteria and actions are collected; the order in which they are written does not change what matches.
const pipeline = new JsnqPipeline(rows).pipe(update('score', 0), where('active', '===', false));
pipeline.count(); // => 1
rows.map((r) => r.score); // => [10, 0]
```

**Every terminal call executes the actions again.** `count()` above already applied
`update('score', 0)`. Calling `all()` afterwards would apply it a second time, which matters for
non-idempotent updates such as `(n) => n + 1`. Call one terminal method, then read `pipeline.data`.
Use `dryRun()` to inspect the effect without applying it.

## Summary table

| Operator | Signature | Kind | What it does |
| --- | --- | --- | --- |
| `where` | `(path, operator, value)` | criterion | Keep nodes whose value at `path` satisfies `operator`. |
| `update` | `(path, valueOrFn)` | value | Write `path` on each match; creates missing containers. `fn(current, node)`. |
| `replace` | `(path, valueOrFn)` | value | Same write as `update`; counted as `replaces` in the stats. |
| `mergeUpdate` | `(path, patch, { deep? })` | value | Merge an object into the object at `path` (shallow, or deep on request). |
| `deleteKey` | `(path)` | value | Delete the key at `path` on each match (splices an array index). |
| `deleteElement` | `()` | element | Remove each matched node from its parent. |
| `insert` | `(data, position = 'inside', keyOrOpts?)` | element | Insert `data` inside, before or after each match. |
| `insertTo` | `(path, data, modeOrOpts = 'inside', key?)` | path | Insert `data` at a path; needs no match; runs once. |
| `moveTo` | `(path, modeOrOpts = 'inside', key?)` | path | Move each match to a path. |
| `copyTo` | `(path, modeOrOpts = 'inside', key?)` | path | Deep-copy each match to a path. |
| `moveToMatches` | `(targetKey, targetOperator, targetValue, mode = 'inside', key?)` | match | Move all sources into the **first** selected target. |
| `copyToMatches` | same | match | Copy all sources into the **first** selected target. |
| `moveToAll` | same | match | Move sources into **every** selected target (extra targets get copies). |
| `copyToAll` | same | match | Copy sources into **every** selected target. |
| `moveToMatchesOverwrite` | `(targetKey, targetOperator, targetValue, overwriteKey)` | match | Move sources into `target[overwriteKey]`, overwriting what is there. |
| `moveToFirstTarget` | same as `moveToMatches` | match | Alias of `moveToMatches`. |
| `copyToFirstTarget` | same as `copyToMatches` | match | Alias of `copyToMatches`. |

`modeOrOpts` is either the mode string (`'inside' | 'before' | 'after'`) or an options object
`{ mode?, key? }`. Path syntax, `$` selectors and `*` wildcards are described in
[paths.md](./paths.md).

## Filtering: `where`

<!-- snippet: skip -->
```ts
where(path: string, operator: ComparisonOperator, value: unknown)
```

Built-in comparison operators:

| Operator | Holds when |
| --- | --- |
| `==`, `!=` | loose (`==`) equality / inequality |
| `===`, `!==` | strict equality / inequality |
| `>`, `>=`, `<`, `<=` | JavaScript relational comparison of the raw values |
| `includes` | the value is a string containing `String(value)`, or an array containing `value` |
| `!includes` | the negation of `includes` (true for values that are neither string nor array) |
| `startsWith`, `endsWith` | both sides are strings and the prefix / suffix matches |
| `regex` | the value is a string and matches; `value` is a `RegExp`, `'pattern'` or `'/pattern/flags'`; an invalid pattern never matches |
| `isArray` | `Array.isArray(actual) === value` (`value` should be a boolean; anything else means `true`) |
| `isObject` | actual is a non-null, non-array object, compared to `value` the same way |

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';

const items = [
  { name: 'Ada', tags: ['a', 'b'], meta: { x: 1 } },
  { name: 'Bob', tags: [], meta: null },
];
const count = (...ops: Parameters<JsnqPipeline<typeof items>['pipe']>) => new JsnqPipeline(items).pipe(...ops).count();

count(where('tags', 'includes', 'b')); // => 1
count(where('name', 'regex', '/^a/i')); // => 1
count(where('name', 'startsWith', 'B')); // => 1
count(where('meta', 'isObject', true)); // => 1
count(where('tags', 'isArray', true)); // => 2
```

Unknown operator names never match. To surface typos, set `operatorsStrict` to `'warn'` (one
entry per operator in `getStats().warnings`) or `'throw'`.

```ts
import { JsnqPipeline, registerOperator } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';

registerOperator('isEven', (actual) => typeof actual === 'number' && actual % 2 === 0);

const rows = [{ n: 1 }, { n: 2 }, { n: 4 }];
new JsnqPipeline(rows).pipe(where('n', 'isEven', undefined)).count(); // => 2

const typo = new JsnqPipeline(rows, { operatorsStrict: 'warn' }).pipe(where('n', 'isEvn' as string, 1));
typo.count(); // => 0
typo.getStats().warnings; // => ["unknown comparison operator 'isEvn'"]
```

`registerOperator(name, (actual, expected) => boolean)` is process-global. Registered operators
are evaluated by the general matcher (not the compiled fast predicate), so they are slower than the
built-ins.

## Value operators

These edit a value on each match and share the path syntax of [paths.md](./paths.md).

### `update(path, valueOrFn)` and `replace(path, valueOrFn)`

Write `value` at `path`, relative to the matched node, creating missing containers. When `value` is
a function it is called as `fn(current, node)`: the current value at `path` (or `undefined`) and the
matched node itself. `replace` performs the identical write; only the stats counter differs.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

const rows = [{ id: 1, a: 1, b: 2 }, { id: 2, a: 5, b: 5 }];
const pipeline = new JsnqPipeline(rows, { immutable: true }).pipe(
  where('id', '===', 1),
  update('sum', (_current: unknown, node: unknown) => (node as { a: number; b: number }).a + (node as { a: number; b: number }).b),
  update('audit.by', 'ann'), // creates audit and audit.by
);
pipeline.all();
pipeline.data; // => [{ id: 1, a: 1, b: 2, sum: 3, audit: { by: 'ann' } }, { id: 2, a: 5, b: 5 }]
```

### `mergeUpdate(path, patch, { deep? })`

Merges `patch` into the object found at `path`. If either side is not an object, `patch` replaces
the value.

- Shallow (default): `{ ...current, ...patch }`. Nested objects in `patch` replace, not merge.
- `{ deep: true }`: objects are merged recursively. Arrays follow the pipeline option
  `arrayMergeStrategy`: `'replace'` (default), `'concat'`, or `'merge-by-key'` with `arrayMergeKey`
  (default key `id`). `merge-by-key` merges elements only when the key is present and unique on
  both sides; missing or duplicate keys are appended as separate entries instead of guessing.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import mergeUpdate from '@adsq/jsnq/operators/mergeUpdate';

const make = () => ({ cfg: { ui: { theme: 'light', size: 1 }, tags: ['a'] } });

const shallow = new JsnqPipeline(make(), { immutable: true }).pipe(
  where('cfg', 'isObject', true),
  mergeUpdate('cfg', { ui: { theme: 'dark' } }),
);
shallow.all();
shallow.data.cfg.ui; // => { theme: 'dark' }

const deep = new JsnqPipeline(make(), { immutable: true, arrayMergeStrategy: 'concat' }).pipe(
  where('cfg', 'isObject', true),
  mergeUpdate('cfg', { ui: { theme: 'dark' }, tags: ['b'] }, { deep: true }),
);
deep.all();
deep.data.cfg; // => { ui: { theme: 'dark', size: 1 }, tags: ['a', 'b'] }
```

### `deleteKey(path)`

Removes the key at `path` on each match; if the final segment indexes an array the element is
spliced out. Deleting a key that does not exist is a no-op (with `strictPathsWarn` it adds a
warning).

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import deleteKey from '@adsq/jsnq/operators/deleteKey';

const users = [{ id: 1, password: 'x', roles: ['a', 'b'] }];
const pipeline = new JsnqPipeline(users, { immutable: true }).pipe(
  where('id', '===', 1),
  deleteKey('password'),
  deleteKey('roles.0'),
);
pipeline.all();
pipeline.data; // => [{ id: 1, roles: ['b'] }]
```

## Element operators

### `deleteElement()`

Removes each matched node from its parent: an array element is spliced out, an object member is
deleted. On a flat array the matches are compacted in a single pass, so deleting half of a large
array is linear, not quadratic.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import deleteElement from '@adsq/jsnq/operators/deleteElement';

const rows = [{ id: 1, done: true }, { id: 2, done: false }, { id: 3, done: true }];
new JsnqPipeline(rows).pipe(where('done', '===', true), deleteElement()).all();
rows.map((r) => r.id); // => [2]
```

### `insert(data, position = 'inside', keyOrOpts?)`

Inserts `data` relative to each match. `position` is `'inside' | 'before' | 'after'`; `keyOrOpts` is
a key (`string | number`) or `{ key }`.

| Position | Match is an array | Match is an object |
| --- | --- | --- |
| `inside` | append, or splice at numeric `key` | needs a string `key`; an object `data` with no key is merged into the match |
| `before` / `after` (match sits in an array) | inserted next to the match | n/a |
| `before` / `after` (match is an object member) | n/a | needs a string `key`; assigned on the parent |

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import insert from '@adsq/jsnq/operators/insert';

const list = [{ id: 1 }, { id: 3 }];
new JsnqPipeline(list).pipe(where('id', '===', 3), insert({ id: 2 }, 'before')).all();
list.map((r) => r.id); // => [1, 2, 3]

const ints = { values: [10, 30] };
new JsnqPipeline(ints).pipe(where('0', '===', 10), insert(20, 'inside', 1)).all();
ints.values; // => [10, 20, 30]

const card = { kind: 'card' };
new JsnqPipeline(card).pipe(where('kind', '===', 'card'), insert({ pinned: true }, 'inside', 'meta')).all();
card; // => { kind: 'card', meta: { pinned: true } }
```

With no `where()` and an array root, `insert(x, 'inside')` is a constant-time push (or a splice at a numeric key).

## Path-targeted structural operators

These write to an explicit path. The path is resolved from the **root** of the data, not from
the match.

### `insertTo(path, data, modeOrOpts = 'inside', key?)`

Inserts `data` at `path`. It needs no `where()` and runs **once per execution**, whether or not
anything matched. Missing path segments are created.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import insertTo from '@adsq/jsnq/operators/insertTo';

const data = { baskets: [{ id: 'b1', items: [] as number[] }, { id: 'b2', items: [] as number[] }] };

new JsnqPipeline(data).pipe(insertTo('baskets.0.items', 7)).all(); // append into an array
new JsnqPipeline(data).pipe(insertTo('baskets.0.items', 5, 'inside', 0)).all(); // at index 0
data.baskets[0].items; // => [5, 7]

// before/after a sibling in an array:
new JsnqPipeline(data).pipe(insertTo('baskets.1', { id: 'b1.5', items: [] }, 'before')).all();
data.baskets.map((b) => b.id); // => ['b1', 'b1.5', 'b2']
```

### `moveTo(path, modeOrOpts = 'inside', key?)` and `copyTo(...)`

Move (or deep-copy) each matched node to `path`. Same position and key rules as `insertTo`.
`moveTo` removes the node from its old parent; `copyTo` leaves it in place and inserts a clone.
With several matches they are inserted in match order.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import moveTo from '@adsq/jsnq/operators/moveTo';
import copyTo from '@adsq/jsnq/operators/copyTo';

const board = {
  todo: [{ id: 1 }, { id: 2 }],
  done: [] as Array<{ id: number }>,
  archive: {} as Record<string, { id: number }>,
};

new JsnqPipeline(board).pipe(where('id', '===', 1), moveTo('done')).all();
board.todo.map((c) => c.id); // => [2]
board.done.map((c) => c.id); // => [1]

// An object target needs an explicit string key.
new JsnqPipeline(board).pipe(where('id', '===', 2), copyTo('archive', 'inside', 'card-2')).all();
board.archive; // => { 'card-2': { id: 2 } }
board.todo.map((c) => c.id); // => [2]
```

## Match-targeted structural operators

<!-- snippet: skip -->
```ts
moveToMatches(targetKey, targetOperator, targetValue, mode = 'inside', key?)
```

The first three arguments select the **targets** (`$` absolute paths or a relative criterion; see
[paths.md](./paths.md#-absolute-targets-and--wildcards)). The sources are the nodes matched by
the pipeline's `where()` criteria.

| | One target | Every target |
| --- | --- | --- |
| **Move** | `moveToMatches` (alias `moveToFirstTarget`) | `moveToAll` |
| **Copy** | `copyToMatches` (alias `copyToFirstTarget`) | `copyToAll` |

- Sources come from the terminal call: `all()` uses every matched source, `first()` only the first.
- `moveToMatches`/`copyToMatches` use the first target in traversal order. `moveToAll`/`copyToAll`
  use every target. Extra targets receive independent clones, never shared references.
- Targets inside the moved source are skipped, and a source that is not attached to a removable
  parent is left in place with a warning.
- Without an explicit `key`, inserting into an **object** target keeps the source's own key when it
  came from an object member, otherwise its `id`. Into an array target the source is appended (or
  placed at a numeric `key`).

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import moveToMatches from '@adsq/jsnq/operators/moveToMatches';
import copyToAll from '@adsq/jsnq/operators/copyToAll';

type Item = { id: number };
const make = () => ({
  catalog: [{ id: 1 }, { id: 2 }] as Item[],
  baskets: [{ items: [] as Item[] }, { items: [] as Item[] }],
});

// all() = both sources, first target only.
const a = make();
new JsnqPipeline(a).pipe(where('id', '>=', 1), moveToMatches('$.baskets.0.items', '===', true)).all();
a.baskets.map((b) => b.items.map((i) => i.id)); // => [[1, 2], []]

// first() = one source, every target.
const b = make();
new JsnqPipeline(b).pipe(where('id', '>=', 1), copyToAll('$.baskets.*.items', '===', true)).first();
b.baskets.map((basket) => basket.items.map((i) => i.id)); // => [[1], [1]]
b.catalog.length; // => 2
```

### `moveToMatchesOverwrite(targetKey, targetOperator, targetValue, overwriteKey)`

Moves each source into `target[overwriteKey]` on every selected **object** target, replacing whatever
is there (subject to `overwritePolicy`). The first target receives the source itself, the others
independent clones.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import moveToMatchesOverwrite from '@adsq/jsnq/operators/moveToMatchesOverwrite';

const data = {
  drafts: [{ kind: 'draft', body: 'v2' }],
  slots: [{ kind: 'slot', current: 'v1' }, { kind: 'slot' }],
};

new JsnqPipeline(data).pipe(
  where('kind', '===', 'draft'),
  moveToMatchesOverwrite('kind', '===', 'slot', 'current'),
).all();

data.drafts; // => []
data.slots.map((slot) => (slot as { current?: { body: string } }).current?.body); // => ['v2', 'v2']
```

## Positions, keys and overwrite policy

Structural operators insert relative to a node or into a container.

| Target | `inside` | `before` / `after` |
| --- | --- | --- |
| Array | append; a numeric `key` is the index (clamped to the array) | placed next to the target element |
| Object | a **string `key` is required** | the parent object gets `key` (string required); objects have no stable order, so a warning is recorded unless `objectOrderWarning: false` |
| Object key that already holds an array | the value is appended to that array instead of replacing it | n/a |

A missing key where one is required throws `insert_to/moveTo/copyTo: explicit string 'key' is
required ...` **before** anything is removed or written. (Earlier versions invented a
name such as `insert_<timestamp>`; that behaviour is gone.) The exceptions are the match-targeted
operators, which derive the key from the source as described above.

`overwritePolicy` decides what happens when the destination slot of an **object** key is occupied:

| Value | Effect |
| --- | --- |
| `'overwrite'` (default) | replace the value; a warning `overwrite at key '...'` is recorded unless `warnOnOverwrite: false` |
| `'skip'` | leave the target alone; the source stays put, stats are not incremented, a warning is recorded |
| `'error'` | throw, before the source is removed |

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import moveTo from '@adsq/jsnq/operators/moveTo';

const make = () => ({ src: [{ kind: 'card', id: 1 }], slots: { main: { id: 99 } } });

const skip = make();
const skipped = new JsnqPipeline(skip, { overwritePolicy: 'skip' })
  .pipe(where('kind', '===', 'card'), moveTo('slots', 'inside', 'main'));
skipped.all();
skip.src.length; // => 1
skip.slots.main.id; // => 99
skipped.getStats().moved; // => 0

const strict = new JsnqPipeline(make(), { overwritePolicy: 'error' })
  .pipe(where('kind', '===', 'card'), moveTo('slots', 'inside', 'main'));
try {
  strict.all();
} catch (error) {
  (error as Error).message; // => "insert overwrite prevented for key 'main'"
}
```

A target path that does not exist yet is created as an **object** (only a numeric next segment creates an
array), so appending to a not-yet-existing list needs a key or the array created first.
`insertTo`, `moveTo` and `copyTo` accept the mode and key either positionally or as `{ mode, key }`.

## Stable match sets and failure behaviour

Structural operations collect the full set of matches first, then act on it, so a node inserted by
`moveTo`/`copyTo`/`insert` is never visited again by the same operation. Multi-source moves keep
source order after removing sources from the highest index down.

Invalid structure fails early and leaves the data untouched:

- moving a node into itself or one of its descendants throws;
- moving the root, or a node with no removable parent, throws for `moveTo` and leaves the source in place with a warning for the `*Matches` family;
- inserting into a primitive target throws before any stat is incremented.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import moveTo from '@adsq/jsnq/operators/moveTo';

const tree = { node: { kind: 'box', children: [{ kind: 'leaf' }] } };
const pipeline = new JsnqPipeline(tree).pipe(where('kind', '===', 'box'), moveTo('node.children'));

try {
  pipeline.all();
} catch (error) {
  (error as Error).message; // => "move: target path 'node.children' is the source or one of its descendants"
}
tree.node.children.length; // => 1
pipeline.getStats().moved; // => 0
```
