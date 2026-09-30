import type { Action, CompiledCriterion, PipelineStats, SearchResultNode } from './types';
import {
  ACTION_CODEGEN, actionValue, canCompile, criteriaCodegenable, criteriaSignature, isCodegenAction, isSingleSegmentKey,
  makeFactoryCache, opExpr, sigPart,
} from '../internal/codegen/common';
import { ACTION_STAT } from '../internal/run-options';

/**
 * Optional codegen fast path for flat-array mutations. Compiles a set of
 * single-segment, non-deep, built-in-operator criteria + value actions into a
 * single `for` loop over the array, removing per-item operator indirection,
 * prepared-action wrappers and plan-path lookups.
 *
 * Falls back to the interpreter whenever anything is not trivially codegen-able:
 * deep `@` criteria, multi-segment paths, regex/custom operators, function values,
 * deep merge_update, or structural actions. The generated code mirrors the semantics of
 * `criteriaMatch` + `applyValueAction` for the supported subset.
 */

export type CompiledFlatMutationOptions = {
  immutable?: boolean;
  dryRun?: boolean;
  needPaths?: boolean;
  strictPathsWarn?: boolean;
  clone?: (v: unknown) => unknown;
  trackOperations?: boolean;
  /** Skip result-node allocation when a host only needs the mutated value/stats. */
  collectResults?: boolean;
};

export type CompiledFlatMutation<T = unknown> = (
  items: T[],
  options: CompiledFlatMutationOptions,
  stats: PipelineStats
) => SearchResultNode<T, unknown, string | number>[];

type FlatMutationFactory = <T>(
  items: T[],
  vals: unknown[],
  opts: CompiledFlatMutationOptions,
  stats: PipelineStats
) => SearchResultNode<T, unknown, string | number>[];

const factories = makeFactoryCache<FlatMutationFactory>(2000);
export function setCompiledMutationCacheLimit(limit: number): void { factories.setLimit(limit); }
export function clearCompiledMutationCache(): void { factories.clear(); }

/** Eligible when the action has a single-segment key and (for update/replace) a non-function value / (merge_update) is shallow. */
function actionIsCodegenable(a: Action): boolean {
  if (!isCodegenAction(a)) return false;
  if (a.type === 'merge_update' ? a.deep === true : a.type !== 'delete_key' && typeof a.value === 'function') return false;
  return isSingleSegmentKey(a.key);
}

export function isFlatMutationCodegenable(
  criteria: ReadonlyArray<CompiledCriterion>,
  actions: ReadonlyArray<Action>
): boolean {
  return canCompile() && criteriaCodegenable(criteria) && actions.length > 0 && actions.every(actionIsCodegenable);
}

function buildFactory(
  criteria: ReadonlyArray<CompiledCriterion>,
  actions: ReadonlyArray<Action>
): FlatMutationFactory | null {
  const predicate = criteria
    .map((c, i) => {
      const key = JSON.stringify(c.segments[0]);
      return `((${key} in it) && (${opExpr(String(c.operator), `it[${key}]`, `vals[${i}]`)}))`;
    })
    .join(' && ');

  const actionLines: string[] = [];
  const statIncrements: string[] = [];
  const operationPushes: string[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!isCodegenAction(a)) return null;
    const spec = ACTION_CODEGEN[a.type];
    const key = JSON.stringify(a.key);
    operationPushes.push(`if (track) operations.push('${a.type} ' + ${key});`);
    statIncrements.push(`stats.${ACTION_STAT[a.type]} += matched;`);
    actionLines.push(
      `if (warnPaths && !Object.prototype.hasOwnProperty.call(target, ${key})) warnings.push("${a.type}: path '" + ${key} + "' did not exist${spec.warnMsg}");`,
      spec.emit(key, `vals[${criteria.length + i}]`, i)
    );
  }

  // Flags, arrays and stat counters are hoisted out of the loop. Counters are flushed once in
  // `finally` (matched is bumped where the per-item stat++ used to run), so `stats` is identical
  // after the call even when the predicate, clone or an action throws mid-loop.
  const source = [
    `var results = [];`,
    `var needPaths = opts.needPaths;`,
    `var collectResults = opts.collectResults !== false;`,
    `var dryRun = opts.dryRun;`,
    `var cow = opts.immutable && !dryRun;`,
    `var track = opts.trackOperations !== false;`,
    `var warnPaths = opts.strictPathsWarn;`,
    `var operations = stats.operations;`,
    `var warnings = stats.warnings;`,
    `var matched = 0;`,
    `try {`,
    `  for (var i = 0; i < items.length; i++) {`,
    `    var it = items[i];`,
    `    if (it === null || typeof it !== 'object') continue;`,
    `    if (!(${predicate})) continue;`,
    `    matched++;`,
    ...operationPushes.map((l) => `    ${l}`),
    `    var target = cow ? opts.clone(it) : it;`,
    ...actionLines.map((l) => `    ${l}`),
    `    if (cow) items[i] = target;`,
    `    if (collectResults && needPaths) results.push({ data: target, path: [String(i)], depth: 1, parent: items, parentKey: i });`,
    `    else if (collectResults) results.push({ data: target, depth: 1 });`,
    `  }`,
    `} finally {`,
    `  stats.resultsFound += matched;`,
    ...statIncrements.map((l) => `  ${l}`),
    `}`,
    `return results;`,
  ].join('\n');

  try {
    return new Function('items', 'vals', 'opts', 'stats', source) as FlatMutationFactory;
  } catch {
    return null;
  }
}

export function compileFlatMutation<T = unknown>(
  criteria: ReadonlyArray<CompiledCriterion>,
  actions: ReadonlyArray<Action>
): CompiledFlatMutation<T> | null {
  if (!isFlatMutationCodegenable(criteria, actions)) return null;
  const sig = criteriaSignature(criteria) + '\x03' + actions.map((a) => sigPart(a.type) + sigPart('key' in a ? a.key : undefined)).join('|');
  const factory = factories.getOrBuild(sig, () => buildFactory(criteria, actions));
  if (!factory) return null;
  const vals = [...criteria.map((c) => c.value), ...actions.map((a) => (isCodegenAction(a) ? actionValue(a) : undefined))];
  return (items, opts, stats) => factory<T>(items, vals, opts, stats);
}
