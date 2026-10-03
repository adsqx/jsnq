import type { Action, CompiledCriterion, PipelineStats, SearchResultNode } from './types';
import {
  actionSource, actionValue, canCompile, criteriaCheckSource, criteriaCodegenable, criteriaSignature, isCodegenAction, isPathKey,
  makeFactoryCache, sigPart,
} from '../internal/codegen/common';
import { createJsonPathPlan, hasJsonPath, type JsonPathPlan } from './data-engine';
import { ACTION_STAT } from '../internal/run-options';

/**
 * Optional codegen fast path for flat-array mutations: compiles non-deep, built-in-operator criteria
 * + value actions (nested keys included) into a single `for` loop over the array (no per-item operator
 * indirection, prepared-action wrappers or plan lookups). Falls back to the interpreter for deep `@`
 * criteria, regex/custom operators, function values, deep merge_update and structural actions.
 * Mirrors `criteriaMatch` + `applyValueAction` for the subset.
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
  stats: PipelineStats,
  hasPath: (root: unknown, plan: JsonPathPlan) => boolean,
) => SearchResultNode<T, unknown, string | number>[];

const factories = makeFactoryCache<FlatMutationFactory>(2000);
export function setCompiledMutationCacheLimit(limit: number): void { factories.setLimit(limit); }
export function clearCompiledMutationCache(): void { factories.clear(); }

/** A path key, and (update/replace) a non-function value / (merge_update) a shallow merge. */
function actionIsCodegenable(a: Action): boolean {
  if (!isCodegenAction(a)) return false;
  if (a.type === 'merge_update' ? a.deep === true : a.type !== 'delete_key' && typeof a.value === 'function') return false;
  return isPathKey(a.key);
}

export function isFlatMutationCodegenable(criteria: ReadonlyArray<CompiledCriterion>, actions: ReadonlyArray<Action>): boolean {
  return canCompile() && criteriaCodegenable(criteria) && actions.length > 0 && actions.every(actionIsCodegenable);
}

function buildFactory(criteria: ReadonlyArray<CompiledCriterion>, actions: ReadonlyArray<Action>): FlatMutationFactory | null {

  const actionLines: string[] = [];
  const statIncrements: string[] = [];
  const operationPushes: string[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!isCodegenAction(a)) return null;
    const plan = createJsonPathPlan(a.key);
    const path = JSON.stringify(plan.path);
    // The interpreter's checks: an own key for a single segment, hasJsonPath for a nested one.
    const exists = plan.segments.length === 1
      ? `Object.prototype.hasOwnProperty.call(target, ${JSON.stringify(plan.key)})`
      : `hasPath(target, vals[${criteria.length + actions.length + i}])`;
    const tail = a.type === 'delete_key' ? '' : '; created implicitly';
    operationPushes.push(`if (track) operations.push(${JSON.stringify(`${a.type} ${plan.path}`)});`);
    statIncrements.push(`stats.${ACTION_STAT[a.type]} += matched;`);
    actionLines.push(
      `if (warnPaths && !${exists}) warnings.push("${a.type}: path '" + ${path} + "' did not exist${tail}");`,
      actionSource(a, plan, `vals[${criteria.length + i}]`, i),
    );
  }

  // Flags, arrays and counters are hoisted out of the loop; counters are flushed once in `finally`,
  // so `stats` is identical to the per-item interpreter even when a predicate, clone or action throws mid-loop.
  const source = [
    // Strict like the interpreter's ES modules: a write to a frozen object or a non-configurable delete throws in both.
    `'use strict';`,
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
    ...criteriaCheckSource(criteria, 'continue').map((l) => `    ${l}`),
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
    return new Function('items', 'vals', 'opts', 'stats', 'hasPath', source) as FlatMutationFactory;
  } catch {
    return null;
  }
}

export function compileFlatMutation<T = unknown>(criteria: ReadonlyArray<CompiledCriterion>, actions: ReadonlyArray<Action>): CompiledFlatMutation<T> | null {
  if (!isFlatMutationCodegenable(criteria, actions)) return null;
  const sig = criteriaSignature(criteria) + '\x03' + actions.map((a) => sigPart(a.type) + sigPart('key' in a ? a.key : undefined)).join('|');
  const factory = factories.getOrBuild(sig, () => buildFactory(criteria, actions));
  if (!factory) return null;
  const vals = [
    ...criteria.map((c) => c.value),
    ...actions.map((a) => (isCodegenAction(a) ? actionValue(a) : undefined)),
    ...actions.map((a) => ('key' in a && typeof a.key === 'string' ? createJsonPathPlan(a.key) : undefined)),
  ];
  return (items, opts, stats) => factory<T>(items, vals, opts, stats, hasJsonPath);
}
