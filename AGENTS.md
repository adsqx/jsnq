# AGENTS.md

Guidance for AI coding agents working in this repository. Human contributors should start
from `README.md`.

## What this package is

`@adsq/jsnq` — a framework-agnostic, zero-dependency JSON pipeline engine. `where` finds nodes
in flat arrays or deeply nested trees; `update` / `mergeUpdate` / `deleteKey` / `insert` / `moveTo` /
`copyTo` / `deleteElement` (and friends) change them, in place, on a clone, or copy-on-write.
It is the query/mutation engine behind `@adsq/solid-signal-store` and `@adsq/angular-signal-store`.

**The API guide for agents that use the package lives in [`SKILL.md`](./SKILL.md)** — read it
before writing code against jsnq. It is written in the [Agent Skills](https://agentskills.io)
format. Consumers can install it as a skill; see the README section "Use With AI Coding Agents".
Reference pages are in [`docs/`](./docs); runnable examples are in [`examples/`](./examples).

## Repository layout

- `src/synced/index.ts` — the root entry (`@adsq/jsnq`).
- `src/synced/core/` — engine modules: `pipeline.ts` (`JsnqPipeline`), `ops.ts` (structural
  insert/move/copy), `actions.ts` (value actions), `match.ts` and `compiled-predicate.ts`
  (criteria), `flat-array-fast-path.ts`, `pipeline-fastpath.ts` and `compiled-mutation.ts`
  (fast paths), `data-engine.ts` (path plans, read/write/delete, cloning), `utils.ts`,
  `operators-registry.ts`, `pipeline-wrapper.ts`, `types.ts`.
- `src/synced/operators/` — one file per operator; `shared.ts` holds the factories they use.
- `src/data-engine.ts` — re-export that becomes the `@adsq/jsnq/data-engine` entry.
- `src/utils/path-safety.ts` — the forbidden-segment set, imported by `core/ops.ts`.
- `test/` — suites and the benchmark, all run with `bun`. `test/types-path-contract.ts` is a
  compile-time contract for `Path` / `PathValue`.
- `examples/`, `docs/` — documentation. Not published, not part of the `tsc` build.
- `scripts/` — build helpers (`clean-dist`, ESM extension rewrite, CJS marker, export check).

`src/synced/` began as a verbatim copy from another repository. **This repository is now the
canonical source** (see `src/synced/SYNC_HEADER.txt`), so engine changes are made here.

## Working rules

- **Every file in `core/` and `operators/` is a public entry point.** `package.json` `exports`
  use the wildcards `./core/*` and `./operators/*`, so `@adsq/jsnq/core/pipeline` and
  `@adsq/jsnq/operators/where` are import paths that consumers rely on. Never rename, move or
  delete those files, and keep each operator's default export. A new operator is a new file in
  `operators/`, an export line in `src/synced/index.ts`, and docs.
- **Zero runtime dependencies.** Do not add any. Do not use Node-only APIs in `src/`: it must run
  in browsers, Node and Bun.
- **All path parsing goes through `core/data-engine.ts`.** It rejects `__proto__`, `prototype` and
  `constructor` segments. Do not add a second parser or bypass the plan compiler, and keep
  `test/jsnq-prototype-guard.test.ts` green.
- **Fast paths must equal the general traversal.** `flat-array-fast-path`, `pipeline-fastpath`
  and the `compiled-*` modules may only handle shapes they can prove equivalent, and must return
  `null` / `undefined` otherwise. `test/jsnq-fastpath-parity.test.ts` is the gate.
- **Copy-on-write is an identity contract.** `tryFastPipelineMutation` and
  `tryFastStructuralMutation` never mutate the input, keep untouched items by reference, and
  return the original when nothing matched. Do not weaken it: the store packages rely on it.
- **Documentation is executable.** README and `docs/` snippets are type-checked and run against
  `src/`, and `examples/` assert their own output. If you change behaviour, update them and run
  `bun run examples`.
- `dist/` and `dist-cjs/` are generated and git-ignored. Never edit or commit them.
- The published tarball is whitelisted by `files` (`dist`, `dist-cjs`, `README.md`, `LICENSE`,
  `SKILL.md`, `AGENTS.md`). Keep `docs/` and `examples/` out of it.
- The sibling stores import only documented entries. Coordinate any breaking change to those
  entries with them.

## Verify before proposing a change

```sh
bun run typecheck
bun run test          # types, units, fast-path parity, data engine, edge, structural, vs-native,
                      # prototype guard, benchmark correctness checks
bun run examples      # six examples that assert their own output
npm run build
npm pack --dry-run    # only dist, dist-cjs, README, LICENSE, SKILL.md, AGENTS.md
```

All must pass. Benchmarks print numbers for a human to read; only their correctness checks gate.
