# Examples

Six short, runnable programs. Each prints what it demonstrates and throws if an expectation
fails, so they double as a regression check for the documented behaviour.

| File | Shows |
| --- | --- |
| [`01-query-flat-array.ts`](./01-query-flat-array.ts) | `where()` with AND and the built-in operators, `all()` / `first()` / `count()`, custom operators |
| [`02-update-nested-tree.ts`](./02-update-nested-tree.ts) | matching at any depth, `update` (value or callback), deep `@` criteria, `mergeUpdate`, `deleteKey`, `dryRun` |
| [`03-structural-move-copy.ts`](./03-structural-move-copy.ts) | `moveTo`, `copyTo`, `moveToMatches`, `copyToAll` with `$` / `*` targets, `insert`, `insertTo`, `deleteElement`, safe failure |
| [`04-data-engine-paths.ts`](./04-data-engine-paths.ts) | `@adsq/jsnq/data-engine`: read / write / delete, path plans, mutation results, the prototype guard |
| [`05-copy-on-write.ts`](./05-copy-on-write.ts) | in-place vs `immutable: true` vs copy-on-write `tryFastPipelineMutation`, with identity checks |
| [`06-typed-paths.ts`](./06-typed-paths.ts) | `Path<T>`, `PathValue<T, P>`, typed updater callbacks |

## Run them

From the repository root (requires [Bun](https://bun.sh)):

```sh
bun install          # once (only needed for the typecheck script)
bun run examples     # all six, in order
bun examples/03-structural-move-copy.ts   # or any single file
bun run examples:typecheck                # tsc over the examples
```

The examples import the published specifiers (`@adsq/jsnq`, `@adsq/jsnq/operators/where`, ...).
[`tsconfig.json`](./tsconfig.json) maps those specifiers onto `../src`, which is how they resolve
without an install. In your own project, drop the files in and the same imports resolve to
`node_modules/@adsq/jsnq`.

`_check.ts` is a 40-line assertion helper so the examples need no test framework and no extra
dev dependencies. `examples/` is not part of the published package.
