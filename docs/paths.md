# Paths and matching

How jsnq addresses data: the path syntax, how `where()` decides what matches, and the three
special forms (`@` deep criteria, `$` absolute targets, `*` wildcard segments).

- [Path syntax](#path-syntax)
- [What a match is](#what-a-match-is)
- [Result nodes](#result-nodes)
- [`@` deep criteria](#-deep-criteria)
- [`$` absolute targets and `*` wildcards](#-absolute-targets-and--wildcards)
- [Relative targets](#relative-targets)
- [Path safety](#path-safety)

## Path syntax

The same parser is used everywhere: `where()` paths, action keys (`update`, `replace`,
`mergeUpdate`, `deleteKey`), positions (`insertTo`, `moveTo`, `copyTo`), `$` targets, and the
[data engine](./data-engine.md).

| Form | Example | Segments |
| --- | --- | --- |
| Dots | `profile.name` | `profile`, `name` |
| Numeric segment | `users.0.name` | `users`, `0`, `name` |
| Bracket index | `users[0].name` | `users`, `0`, `name` |
| Quoted key | `settings["display.name"]` or `settings['display.name']` | `settings`, `display.name` |
| Backslash escape | `a\.b.c` | `a.b`, `c` |
| Empty path | `''` | none: the root itself (data engine reads) |

Empty tokens are dropped (`a..b` is `a`, `b`), and `users.[0].name` is accepted too.
Segments are always strings internally; a numeric segment indexes an array and is an ordinary
key on an object.

```ts
import { splitJsonPath, readJsonPath } from '@adsq/jsnq/data-engine';

splitJsonPath('users[0].profile["display.name"]'); // => ['users', '0', 'profile', 'display.name']
splitJsonPath('a\\.b.c'); // => ['a.b', 'c']
readJsonPath({ 'a.b': 1 }, 'a\\.b'); // => 1
```

`buildPath()` goes the other way: it turns segments into a path string, quoting where needed.

```ts
import { buildPath } from '@adsq/jsnq';

buildPath('users', 0, 'display.name'); // => 'users[0]["display.name"]'
```

When a write has to create missing containers, a numeric next segment creates an array and
anything else creates an object (`users.0.name` on `{}` gives `{ users: [{ name }] }`).

## What a match is

A pipeline walks the whole tree depth-first: the root (depth 0), then every descendant, arrays
in index order and objects in key order, down to `maxDepth` levels (default `10`). Each visited
node is tested against every `where()` criterion. A node matches when **all** criteria hold.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';

const tree = {
  id: 1,
  children: [{ id: 2, children: [{ id: 3 }] }, { id: 4 }],
};

// where() is not restricted to rows of a top-level array: any node with id >= 3 matches.
new JsnqPipeline(tree).pipe(where('id', '>=', 3)).count(); // => 2
// The root is a node too.
new JsnqPipeline(tree).pipe(where('id', '===', 1)).count(); // => 1
```

Rules for a single criterion `where(path, operator, value)`:

- The path is resolved **relative to the visited node**. The first segment must exist on the node
  (an own key of an object, an in-range index of an array), otherwise the node does not match.
  A key that is present with the value `undefined` does match `'==='`, `undefined`.
- A single `length` segment on an array node reads its length: `where('length', '===', 0)`
  matches empty arrays.
- Wildcards are not supported in `where()` paths; use `@` (below) to search nested arrays.
- With no `where()` at all, every node matches, root included. An action without a criterion is
  therefore applied to the root and to each descendant; add a `where()` unless that is intended.
- `maxDepth` bounds the walk. Nodes deeper than `maxDepth` are never visited, so they neither
  match nor receive actions. Raise it for deeper documents.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';

const deep = { a: { b: { c: { id: 1 } } } }; // the id node is at depth 3

new JsnqPipeline(deep).pipe(where('id', '===', 1)).count(); // => 1
new JsnqPipeline(deep, { maxDepth: 2 }).pipe(where('id', '===', 1)).count(); // => 0
new JsnqPipeline([[1, 2], []]).pipe(where('length', '===', 0)).count(); // => 1
```

`includeArrays: false` / `includeObjects: false` stop the walk from descending into that kind of
container. `limit: n` (or `.first()`) stops after `n` matches.

## Result nodes

`all()` returns `SearchResultNode[]`:

| Field | Meaning |
| --- | --- |
| `data` | The matched value (a live reference into the working data, not a copy). |
| `path` | Segments from the root as strings, e.g. `['users', '0']`. Present unless `returnPaths: false`. |
| `depth` | Depth below the root (root is `0`). |
| `parent`, `parentKey` | The containing object/array and this node's key or index. Filled only when a structural action needs them (`deleteElement`, move/copy, relative insert). |

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';

const data = { team: { members: [{ id: 7, name: 'Ada' }] } };
const [node] = new JsnqPipeline(data).pipe(where('id', '===', 7)).all();

node.path; // => ['team', 'members', '0']
node.depth; // => 3
node.data; // => { id: 7, name: 'Ada' }
```

`all()` types each node's `data` as the pipeline's root type. Narrow it yourself
(`node.data as unknown as Member`) or use `first<T>()`, which is generic.

## `@` deep criteria

`arrayKey@subpath` searches an array **and every nested array under the same key**. It is built
for trees like form definitions or menus, where `fields` contains items that contain `fields`.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';

const form = {
  id: 'signup',
  fields: [
    { id: 'name', type: 'text' },
    { id: 'address', type: 'group', fields: [{ id: 'city', type: 'text' }] },
  ],
};

const found = new JsnqPipeline(form).pipe(where('fields@id', '===', 'city')).all();
found.map((node) => node.path?.join('.')); // => ['fields.1.fields.0']
```

- `fields@id`: starting at the visited node, read the array at `fields`, test each element's `id`,
  then descend into each element's own `fields`. Matched nodes are the elements. Descent is bounded
  by `maxDepth` and skips arrays it has already seen on the current branch (cycle guard).
- `@id` (nothing before the `@`): test the visited node's own `id`. It behaves like `id` but always
  uses the general traversal.
- Deep criteria work with actions: `where('fields@id', '===', 'city'), update('label', 'Town')`
  edits the matched element.
- A pipeline containing a deep criterion always takes the general traversal, not the flat-array
  fast path.

## `$` absolute targets and `*` wildcards

The `*Matches` and `*All` operators (`moveToMatches`, `copyToMatches`, `moveToAll`, `copyToAll`,
`moveToMatchesOverwrite`) take a **target selector** as their first three arguments
`(targetKey, targetOperator, targetValue)`. A `targetKey` that starts with `$` is an absolute path
from the root:

- `$.baskets[0].items` and `$.baskets.0.items` are the same selector.
- The operator and value are ignored; the selector picks the node at that path (nothing if the
  path does not exist). Pass `'==='`, `true` by convention.
- A whole segment of `*` matches any single key or index at that position:
  `$.baskets.*.items` selects `items` in every basket. Wildcards are matched segment by segment,
  so the path must have the same length. `*` cannot be mixed with other characters in a segment.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import copyToAll from '@adsq/jsnq/operators/copyToAll';
import copyToMatches from '@adsq/jsnq/operators/copyToMatches';

type Item = { id: number };
const makeData = () => ({
  catalog: [{ id: 1 }],
  baskets: [{ items: [] as Item[] }, { items: [] as Item[] }],
});

const first = makeData();
new JsnqPipeline(first).pipe(where('id', '===', 1), copyToMatches('$.baskets.0.items', '===', true)).all();
first.baskets.map((b) => b.items.length); // => [1, 0]

const every = makeData();
new JsnqPipeline(every).pipe(where('id', '===', 1), copyToAll('$.baskets.*.items', '===', true)).all();
every.baskets.map((b) => b.items.length); // => [1, 1]
```

## Relative targets

Without `$`, the selector is another criterion, evaluated on every node in the tree exactly like
`where()`: the **nodes where it holds are the targets**.

```ts
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import moveToMatches from '@adsq/jsnq/operators/moveToMatches';

type Item = { id: number };
const data = { inbox: [{ id: 1 }] as Item[], archive: [] as Item[], other: [{ id: 2 }] as Item[] };

// 'length' === 0 selects empty arrays, so this moves the id 1 node into `archive`.
new JsnqPipeline(data).pipe(where('id', '===', 1), moveToMatches('length', '===', 0)).all();
data.archive; // => [{ id: 1 }]
data.inbox; // => []
```

Two things to keep in mind:

1. The selector picks the node that **satisfies** the criterion, not a property of it.
   `moveToMatches('items', 'isArray', true)` targets every *object that has an `items` array*
   (the container), not the `items` array itself. If you want the array, select it by its own
   properties (`'length'`) or use a `$` path.
2. `moveToMatches` and `copyToMatches` use only the **first** selected target in traversal order;
   `moveToAll` and `copyToAll` use **every** target. Targets that sit inside a source being moved
   are skipped.

## Path safety

`__proto__`, `prototype` and `constructor` are rejected as path segments. See
[Safety in the README](../README.md#safety) for the exact coverage and its limits.
