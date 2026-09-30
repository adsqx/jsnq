import {
  Action,
  CompiledCriterion,
  JsonOperator,
  PipelineLike,
  PipelineStats,
  SearchOptions,
  SearchResultNode,
  CopyAction,
  MoveAction,
  InsertAction,
  InsertToAction,
  MoveMatchesAction,
  MoveMatchesOverwriteAction,
  JsonLike,
} from './types';
import { dfsIterator, scanJsonMatches, getBySegments, isObject, isRecordObject, resolveTargetWithPathCreation, hasPath, cloneJson, deepArrayIterator } from './utils';
import { criteriaMatch, criterionMatches, enforceKnownOperator, StrictOperatorContext } from './match';
import { compileCriteriaPredicate } from './compiled-predicate';
import { applyValueAction, prepareActions, PreparedAction } from './actions';
import { assertCanInsertIntoTargetPath, assignWithPolicy, canInsertIntoResolvedTarget, canInsertRelative, canRemoveFromOriginal, getAssignmentEffect, insertIntoTargetPath, insertRelative, removeFromOriginal, selectTargets, fanoutMatchesToTargets, orderMatchesForMove, wouldCreateMoveCycle, wouldCreateMoveCycleAtPath } from './ops';
import { executeFlatArrayFastPath } from './flat-array-fast-path';
import { createStats, DEFAULT_MAX_DEPTH, resetStats, resolveRun, resolveTraversal } from '../internal/run-options';

// Actions that need parent/index metadata from the traversal to apply correctly.
const META_ACTIONS = new Set<Action['type']>([
  'delete_element',
  'move',
  'move_matches',
  'move_matches_overwrite',
  'move_first_to_matches',
  'copy_matches',
  'copy_first_to_matches',
]);

// Global fan-out actions: move/copy all matches into selected targets.
const MATCH_FANOUT: Partial<Record<Action['type'], { kind: 'move' | 'copy'; allTargets: boolean }>> = {
  move_matches: { kind: 'move', allTargets: false },
  copy_matches: { kind: 'copy', allTargets: false },
  move_first_to_matches: { kind: 'move', allTargets: true },
  copy_first_to_matches: { kind: 'copy', allTargets: true },
};

export class JsnqPipeline<TData extends JsonLike = JsonLike> implements PipelineLike<TData> {
  private _data: TData;
  get data(): TData { return this._data; }
  readonly criteria: ReadonlyArray<CompiledCriterion>;
  readonly actions: ReadonlyArray<Action>;
  readonly options: Readonly<SearchOptions>;

  private readonly stats: PipelineStats = createStats();
  private warnedUnknownOps = new Set<string>();
  private strictCtx: StrictOperatorContext = { warnedUnknownOps: this.warnedUnknownOps, warnings: this.stats.warnings };
  private immutableApplied = false;
  private preparedActions: PreparedAction[] | null = null;

  constructor(data: TData, options: SearchOptions = {}, criteria: CompiledCriterion[] = [], actions: Action[] = []) {
    this._data = data;
    this.options = {
      maxDepth: 10,
      includeArrays: true,
      includeObjects: true,
      earlyTermination: false,
      limit: undefined,
      buildMeta: true,
      returnPaths: true,
      ...options
    };
    this.criteria = criteria;
    this.actions = actions;
  }

  private spawn(next: { data?: TData; options?: SearchOptions; criteria?: CompiledCriterion[]; actions?: Action[] }): JsnqPipeline<TData> {
    return new JsnqPipeline<TData>(
      next.data ?? this.data,
      next.options ?? (this.options as SearchOptions),
      next.criteria ?? (this.criteria as CompiledCriterion[]),
      next.actions ?? (this.actions as Action[])
    );
  }

  with(next: { data?: TData; options?: SearchOptions; criteria?: CompiledCriterion[]; actions?: Action[] }): JsnqPipeline<TData> {
    return this.spawn(next);
  }

  immutable(mode: true | 'auto' = true): JsnqPipeline<TData> {
    return this.with({ options: { ...(this.options as SearchOptions), immutable: mode } });
  }

  dryRun(enabled: boolean = true): JsnqPipeline<TData> {
    return this.with({ options: { ...(this.options as SearchOptions), dryRun: enabled } });
  }

  pipeline(...ops: Array<JsonOperator<JsnqPipeline<TData>>>): JsnqPipeline<TData> { return this.pipe(...ops); }

  pipe(...ops: Array<JsonOperator<JsnqPipeline<TData>>>): JsnqPipeline<TData> {
    return ops.reduce<JsnqPipeline<TData>>((acc, op) => op(acc), this);
  }

  clone(): JsnqPipeline<TData> { return this.spawn({}); }

  first(): TData | null;
  first<T = unknown>(): T | null;
  first<T = unknown>(): T | null {
    const limited = this.spawn({ options: { ...(this.options as SearchOptions), earlyTermination: true } });
    const res = limited.execute();
    return res.length ? (res[0].data as unknown as T) : null;
  }

  all(): SearchResultNode<TData, unknown, string | number>[] { return this.execute(); }

  count(): number { return this.execute().length; }

  getStats(): PipelineStats {
    return {
      ...this.stats,
      warnings: [...this.stats.warnings],
      operations: [...this.stats.operations],
    };
  }

  private actionsRequireMeta(): boolean {
    return this.actions.some((a) =>
      META_ACTIONS.has(a.type) ||
      (a.type === 'insert' && !!(a as InsertAction).position && (a as InsertAction).position !== 'inside')
    );
  }

  private getPreparedActions(): PreparedAction[] {
    return this.preparedActions ??= prepareActions(this.actions);
  }

  private execute(): SearchResultNode<TData, unknown, string | number>[] {
    const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
    const t0 = now();
    resetStats(this.stats);
    this.strictCtx = { warnedUnknownOps: this.warnedUnknownOps, warnings: this.stats.warnings };

    // Enforce strict-operator policy once per execute() instead of once per visited node.
    // After this a compiled predicate can safely replace the interpreter for codegenable
    // non-deep criteria without losing warnings / throw semantics.
    for (let i = 0; i < this.criteria.length; i++) {
      enforceKnownOperator(this.criteria[i], this.options, this.strictCtx);
    }
    const compiledPred = !this.criteria.some((c) => c.isDeep)
      ? compileCriteriaPredicate(this.criteria)
      : null;

    const out: SearchResultNode<TData, unknown, string | number>[] = [];
    try {
      const needMeta = this.actionsRequireMeta(); // auto: only when actions truly need parent/index metadata
      const { needPaths, limit, shouldClone } = resolveRun(this.options, this.actions.length);
      const traversal = resolveTraversal(this.options);

      // Immutable mode: clone data before traversal so iterator nodes point at the working copy.
      if (shouldClone && !this.immutableApplied) {
        this._data = cloneJson(this.data);
        this.immutableApplied = true;
      }

      const rootArrayInsertFastPath = this.executeRootArrayInsertFastPath(needPaths);
      if (rootArrayInsertFastPath) return rootArrayInsertFastPath;

      const flatArrayFastPath = executeFlatArrayFastPath({
        data: this.data,
        criteria: this.criteria,
        actions: this.actions,
        options: this.options,
        stats: this.stats,
        warnedUnknownOps: this.warnedUnknownOps,
        immutableApplied: this.immutableApplied,
      });
      if (flatArrayFastPath) {
        this._data = flatArrayFastPath.data as TData;
        this.immutableApplied = flatArrayFastPath.immutableApplied;
        return flatArrayFastPath.results as SearchResultNode<TData, unknown, string | number>[];
      }

      // Check if we have deep criteria with arrayKey (requires special handling)
      const hasDeepArrayCriteria = this.criteria.some(c => c.isDeep && c.deepArrayKey);
      const seenDeepObjects = hasDeepArrayCriteria ? new WeakSet<object>() : undefined;
      const seenDeepPathKeys = hasDeepArrayCriteria ? new Set<string>() : undefined;

      if (this.actions.length === 0 && !needPaths && !this.criteria.some((c) => c.isDeep)) {
        return this.executeSearchOnlyFastPath(limit) as SearchResultNode<TData, unknown, string | number>[];
      }

      const preparedActions = this.actions.length > 0 ? this.getPreparedActions() : null;
      // Moving/copying while the DFS iterator is still walking the same graph can make
      // an inserted node visible to that iterator and apply the action twice. Collect
      // the stable match set first, then preserve the declared action order per match.
      const deferNodeActions = this.actions.some((action) => action.type === 'insert' || action.type === 'move' || action.type === 'copy');

      if (hasDeepArrayCriteria) {
        for (const node of dfsIterator(this.data, {
          ...traversal,
          buildMeta: needMeta,
          returnPaths: needPaths,
        })) {
          this.stats.nodesVisited++;
          this.stats.maxDepth = Math.max(this.stats.maxDepth, node.depth);
          // Special handling for deep array criteria
          if (this.matchesSequential(node, out, seenDeepObjects, seenDeepPathKeys, !deferNodeActions)) {
            if (limit && out.length >= limit) break;
          }
        }
      } else {
        const scan = scanJsonMatches(this.data, {
          ...traversal,
          buildMeta: needMeta,
          returnPaths: needPaths,
        }, (node) => this.criteria.length === 0 || (
          compiledPred ? compiledPred(node) : criteriaMatch(this.criteria, node, this.options, this.strictCtx)
        ), (node) => {
          this.stats.resultsFound++;
          if (preparedActions && !deferNodeActions) this.applyActions(node, preparedActions);
          out.push(node as SearchResultNode<TData, unknown, string | number>);
          if (limit && out.length >= limit) return false;
        });
        this.stats.nodesVisited += scan.nodesVisited;
        this.stats.maxDepth = Math.max(this.stats.maxDepth, scan.maxDepth);
      }
      if (preparedActions && deferNodeActions) {
        for (const node of out) this.applyActions(node, preparedActions);
      }
      this.applyGlobalActions(out);
    } finally {
      this.stats.searchTime = now() - t0;
    }
    return out;
  }

  private executeRootArrayInsertFastPath(needPaths: boolean): SearchResultNode<TData, unknown, string | number>[] | null {
    if (!Array.isArray(this.data)) return null;
    if (this.criteria.length !== 0 || this.actions.length !== 1) return null;
    const action = this.actions[0];
    if (!action || action.type !== 'insert') return null;

    const { data, position, key } = action as InsertAction;
    if (position !== 'inside') return null;

    if (!this.options.dryRun) {
      if (typeof key === 'number') {
        const index = Math.max(0, Math.min(this.data.length, key));
        (this.data as unknown[]).splice(index, 0, data);
      } else {
        (this.data as unknown[]).push(data);
      }
    }

    this.stats.nodesVisited++;
    this.stats.resultsFound++;
    this.stats.inserted++;
    if (this.options.trackOperations !== false) this.stats.operations.push('insert root-array inside');

    return [{
      data: data as TData,
      path: needPaths ? [String(typeof key === 'number' ? key : Math.max(0, this.data.length - 1))] : undefined,
      depth: 1,
    } as SearchResultNode<TData, unknown, string | number>];
  }

  private matchesSequential(
    node: SearchResultNode,
    out: SearchResultNode<TData, unknown, string | number>[],
    seenDeepObjects?: WeakSet<object>,
    seenDeepPathKeys?: Set<string>,
    applyActionsNow = true
  ): boolean {
    // Process criteria sequentially - each deep arrayKey criterion descends into nested elements
    let currentNodes: SearchResultNode[] = [node];

    for (let i = 0; i < this.criteria.length; i++) {
      const c = this.criteria[i];
      const nextNodes: SearchResultNode[] = [];

      for (const currentNode of currentNodes) {
        if (c.isDeep && c.deepArrayKey) {
          // Deep array criterion - descend into nested elements
          for (const deepNode of deepArrayIterator(
            currentNode.data,
            c.deepArrayKey,
            c.segments,
            c.opFn,
            c.value,
            currentNode.path || [],
            currentNode.depth,
            this.options.maxDepth ?? DEFAULT_MAX_DEPTH
          )) {
            nextNodes.push(deepNode as SearchResultNode);
          }
        } else if (c.isDeep) {
          // @id criterion - check current node
          if (c.opFn(getBySegments(currentNode.data, c.segments), c.value)) {
            nextNodes.push(currentNode);
          }
        } else if (criterionMatches(c, currentNode.data)) {
          nextNodes.push(currentNode);
        }
      }

      if (nextNodes.length === 0) return false;
      currentNodes = nextNodes;
    }

    // All criteria matched - process final nodes
    let emitted = false;
    for (const finalNode of currentNodes) {
      if (!this.markDeepResult(finalNode, seenDeepObjects, seenDeepPathKeys)) {
        continue;
      }
      this.stats.resultsFound++;
      if (applyActionsNow && this.actions.length > 0) this.applyActions(finalNode, this.getPreparedActions());
      out.push(finalNode as SearchResultNode<TData, unknown, string | number>);
      emitted = true;
    }

    return emitted;
  }

  private markDeepResult(
    node: SearchResultNode,
    seenDeepObjects?: WeakSet<object>,
    seenDeepPathKeys?: Set<string>
  ): boolean {
    if (!seenDeepObjects && !seenDeepPathKeys) return true;
    if (isObject(node.data)) {
      if (seenDeepObjects?.has(node.data)) return false;
      seenDeepObjects?.add(node.data);
      return true;
    }
    const pathKey = node.path?.join('\u0000') ?? `${node.depth}:${String(node.data)}`;
    if (seenDeepPathKeys?.has(pathKey)) return false;
    seenDeepPathKeys?.add(pathKey);
    return true;
  }

  private executeSearchOnlyFastPath(limit: number | undefined): SearchResultNode<unknown, unknown, string | number>[] {
    const out: SearchResultNode<unknown, unknown, string | number>[] = [];
    const { maxDepth, includeArrays, includeObjects } = resolveTraversal(this.options);
    // Codegen fast path: one compiled predicate replaces per-node operator indirection.
    // null (deep/multi-seg/custom-op/CSP) → keep the interpreter; results stay identical.
    const pred = compileCriteriaPredicate(this.criteria);

    // Top-level fast path: with maxDepth 1 an array root cannot be descended into, so the
    // full DFS would only ever check the root + its direct items. Iterate them directly —
    // no per-node stack frames, no child pushes — which is near-native for flat filtering.
    // (No nested-candidate guard needed: maxDepth 1 forbids descent by definition.)
    if (maxDepth === 1 && Array.isArray(this.data) && includeArrays) {
      const items = this.data as unknown[];
      this.stats.maxDepth = Math.max(this.stats.maxDepth, 1);
      this.stats.nodesVisited++; // root array node
      // Hoist the pred/interpreter choice out of the loop so the per-item call site stays
      // monomorphic (no per-item closure indirection). Root checked first (depth 0).
      if (pred) {
        if (pred(items)) {
          this.stats.resultsFound++;
          out.push({ data: items, depth: 0 });
          if (limit && out.length >= limit) return out;
        }
        for (let i = 0; i < items.length; i++) {
          this.stats.nodesVisited++;
          const node = items[i];
          if (pred(node)) {
            this.stats.resultsFound++;
            out.push({ data: node, depth: 1 });
            if (limit && out.length >= limit) break;
          }
        }
      } else {
        if (criteriaMatch(this.criteria, items, this.options, this.strictCtx)) {
          this.stats.resultsFound++;
          out.push({ data: items, depth: 0 });
          if (limit && out.length >= limit) return out;
        }
        for (let i = 0; i < items.length; i++) {
          this.stats.nodesVisited++;
          const node = items[i];
          if (criteriaMatch(this.criteria, node, this.options, this.strictCtx)) {
            this.stats.resultsFound++;
            out.push({ data: node, depth: 1 });
            if (limit && out.length >= limit) break;
          }
        }
      }
      return out;
    }

    const nodes: unknown[] = [this.data];
    const depths: number[] = [0];

    while (nodes.length) {
      const node = nodes.pop();
      const depth = depths.pop()!;
      this.stats.nodesVisited++;
      if (depth > this.stats.maxDepth) this.stats.maxDepth = depth;

      if (pred ? pred(node) : criteriaMatch(this.criteria, node, this.options, this.strictCtx)) {
        this.stats.resultsFound++;
        out.push({ data: node, depth });
        if (limit && out.length >= limit) break;
      }

      if (depth >= maxDepth) continue;
      const nextDepth = depth + 1;
      if (Array.isArray(node) && includeArrays) {
        for (let i = node.length - 1; i >= 0; i--) {
          nodes.push(node[i]);
          depths.push(nextDepth);
        }
      } else if (isObject(node) && includeObjects) {
        const keys = Object.keys(node);
        for (let i = keys.length - 1; i >= 0; i--) {
          nodes.push(node[keys[i]]);
          depths.push(nextDepth);
        }
      }
    }

    return out;
  }

  private applyMoveOrCopy(
    node: SearchResultNode,
    action: MoveAction | CopyAction,
    kind: 'move' | 'copy'
  ): void {
    const { position, mode, key } = action;
    const isCopy = kind === 'copy';
    // Both operations share the same insertion contract. Validate before clone,
    // removal, path creation, or stats so an invalid copy cannot become a silent
    // no-op reported as successful.
    const validatedTarget = assertCanInsertIntoTargetPath(this.data, position, mode, key);
    if (!canInsertIntoResolvedTarget(validatedTarget, node.data, mode, key, this.options)) {
      if (this.options.warnOnOverwrite !== false) this.stats.warnings.push(`${kind}: target write skipped by overwrite policy`);
      return;
    }
    if (!isCopy) {
      if (!canRemoveFromOriginal(node)) throw new Error('move: source is not attached to a removable parent');
      if (wouldCreateMoveCycleAtPath(this.data, node.data, position)) {
        throw new Error(`move: target path '${position}' is the source or one of its descendants`);
      }
    }
    if (!this.options.dryRun) {
      if (this.options.strictPathsWarn && !hasPath(this.data, position)) {
        this.stats.warnings.push(`${kind}: target path '${position}' did not exist; created implicitly`);
      }
      const element = isCopy ? cloneJson(node.data) : node.data;
      const plannedTarget = resolveTargetWithPathCreation(this.data, position);
      if (!isCopy && !removeFromOriginal(node)) throw new Error('move: source changed before it could be removed');
      // Reuse the pre-resolved target for both move and copy: insertIntoTargetPath
      // inserts INTO the target (never replaces it), so plannedTarget stays valid.
      // Previously copy re-resolved from root per call — a redundant O(depth) traversal.
      insertIntoTargetPath(
        this.data,
        position,
        element,
        mode,
        () => plannedTarget,
        key,
        this.options,
        this.stats
      );
    }
    this.stats[isCopy ? 'copied' : 'moved']++;
    if (this.options.trackOperations !== false) this.stats.operations.push(`${kind} -> ${position}`);
  }

  private applyActions(node: SearchResultNode, preparedActions: PreparedAction[]): void {
    for (const prepared of preparedActions) {
      if (prepared.plan !== null) {
        applyValueAction(node.data, prepared, this.options, this.stats);
        continue;
      }
      const a = prepared.action;
      switch (a.type) {
        case 'delete_element': {
          if (!this.options.dryRun) removeFromOriginal(node);
          this.stats.deletedElements++;
          if (this.options.trackOperations !== false) this.stats.operations.push(`delete_element at ${node.path?.join('.') ?? '<unknown>'}`);
          break;
        }
        case 'insert': {
          const { data, position, key } = a as InsertAction;
          const insertable = canInsertRelative(node, data, position, key, this.options);
          if (!insertable) {
            if (this.options.warnOnOverwrite !== false) {
              const target = typeof key === 'string' || typeof key === 'number' ? ` '${key}'` : '';
              this.stats.warnings.push(`insert: target${target} is not writable; operation skipped`);
            }
            break;
          }
          if (!this.options.dryRun && !insertRelative(node, data, position, key, this.options, this.stats)) break;
          this.stats.inserted++;
          if (this.options.trackOperations !== false) this.stats.operations.push(`insert ${position} ${typeof key === 'number' ? `index=${key}` : (key ?? '')}`);
          break;
        }
        case 'move':
        case 'copy': {
          this.applyMoveOrCopy(node, a as MoveAction | CopyAction, a.type);
          break;
        }
      }
    }
  }

  private applyInsertTo(action: InsertToAction): void {
    const { position, data, mode, key } = action;
    const validatedTarget = assertCanInsertIntoTargetPath(this.data, position, mode, key);
    if (!canInsertIntoResolvedTarget(validatedTarget, data, mode, key, this.options)) {
      if (this.options.warnOnOverwrite !== false) {
        const target = typeof key === 'string' || typeof key === 'number' ? `${position}.${key}` : position;
        this.stats.warnings.push(`insert_to: target '${target}' write skipped by overwrite policy`);
      }
      return;
    }
    if (this.options.strictPathsWarn && !hasPath(this.data, position)) {
      this.stats.warnings.push(`insert_to: target path '${position}' did not exist; created implicitly`);
    }
    if (!this.options.dryRun) {
      insertIntoTargetPath(this.data, position, data, mode, resolveTargetWithPathCreation, key, this.options, this.stats);
    }
    this.stats.inserted++;
    if (this.options.trackOperations !== false) this.stats.operations.push(`insert_to ${position} ${mode ?? 'inside'} ${typeof key === 'number' ? `index=${key}` : (key ?? '')}`);
  }

  private applyMatchFanout(
    action: MoveMatchesAction,
    fan: { kind: 'move' | 'copy'; allTargets: boolean },
    matches: SearchResultNode[]
  ): void {
    const { targetKey, targetOperator, targetValue, mode, key } = action;
    const targetsAll = selectTargets(
      this.data,
      this.options,
      targetKey,
      targetOperator,
      targetValue,
      (mode ?? 'inside') !== 'inside',
    );
    const targets = fan.allTargets ? targetsAll : (targetsAll.length ? [targetsAll[0]] : []);
    const applied = fanoutMatchesToTargets(
      fan.kind,
      matches,
      targets,
      mode,
      key,
      this.options,
      this.stats,
      !!this.options.dryRun,
    );
    if (fan.kind === 'move') this.stats.moved += applied;
    else this.stats.copied += applied;
    if (this.options.trackOperations !== false) this.stats.operations.push(
      fan.allTargets
        ? `${action.type} -> ${targets.length} targets`
        : `${action.type} -> first target (${targets[0]?.path?.join('.') ?? 'none'})`
    );
  }

  private applyMoveMatchesOverwrite(action: MoveMatchesOverwriteAction, matches: SearchResultNode[]): void {
    const { targetKey, targetOperator, targetValue, overwriteKey } = action;
    const targets = selectTargets(this.data, this.options, targetKey, targetOperator, targetValue, false);
    const objectTargets = targets.filter((target) => isRecordObject(target.data));
    const ordered = orderMatchesForMove(matches);
    for (const src of ordered) {
      if (!canRemoveFromOriginal(src)) {
        this.stats.warnings.push('move_matches_overwrite: source is not attached to a removable parent; source left in place');
        continue;
      }
      const writableTargets = objectTargets.filter((target) => {
        if (wouldCreateMoveCycle(src.data, target, 'inside')) return false;
        const targetData = target.data as Record<string, unknown>;
        const exists = overwriteKey in targetData;
        const effect = getAssignmentEffect(
          targetData,
          overwriteKey,
          this.options,
          (conflictKey) => new Error(`copy/move overwrite prevented for key '${conflictKey}'`)
        );
        if (effect === 'skip' && this.options.warnOnOverwrite !== false && exists) {
          this.stats.warnings.push(`overwrite at key '${overwriteKey}'`);
        }
        return effect === 'write';
      });
      if (writableTargets.length === 0) {
        this.stats.warnings.push('move_matches_overwrite: no writable object targets; source left in place');
        continue;
      }
      if (!this.options.dryRun) {
        if (!removeFromOriginal(src)) throw new Error('move_matches_overwrite: source changed before it could be removed');
        for (let i = 0; i < writableTargets.length; i++) {
          const t = writableTargets[i];
          assignWithPolicy(
            t.data as Record<string, unknown>,
            overwriteKey,
            i === 0 ? src.data : cloneJson(src.data),
            this.options,
            this.stats,
            (conflictKey) => new Error(`copy/move overwrite prevented for key '${conflictKey}'`)
          );
        }
      }
      this.stats.moved++;
      if (this.options.trackOperations !== false) this.stats.operations.push(`move_matches_overwrite -> ${overwriteKey}`);
    }
  }

  private applyGlobalActions(matches: SearchResultNode[]): void {
    for (const a of this.actions) {
      if (a.type === 'insert_to') {
        this.applyInsertTo(a as InsertToAction);
        continue;
      }
      if (!matches || matches.length === 0) continue;
      if (a.type === 'move_matches_overwrite') {
        this.applyMoveMatchesOverwrite(a as MoveMatchesOverwriteAction, matches);
        continue;
      }
      const fan = MATCH_FANOUT[a.type];
      if (fan) this.applyMatchFanout(a as MoveMatchesAction, fan, matches);
    }
  }
}

export default JsnqPipeline;
