import type {
  Action, CompiledCriterion, JsonOperator, PipelineLike, PipelineStats, SearchOptions, SearchResultNode, JsonLike,
} from './types';
import { cloneJson } from './utils';
import type { StrictOperatorContext } from './match';
import { prepareActions, PreparedAction } from './actions';
import { executeFlatArrayFastPath } from './flat-array-fast-path';
import { createStats, DEFAULT_MAX_DEPTH, resetStats, resolveRun } from '../internal/run-options';
import { planCriteria, rootArrayInsert, runSearch } from '../internal/pipeline/run';

const now = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/** Result nodes are built untyped by the engine; their `data` is a subtree of `TData`. */
const typed = <TData>(nodes: SearchResultNode[]): SearchResultNode<TData, unknown, string | number>[] =>
  nodes as SearchResultNode<TData, unknown, string | number>[];

export class JsnqPipeline<TData extends JsonLike = JsonLike> implements PipelineLike<TData> {
  private _data: TData;
  get data(): TData { return this._data; }
  readonly criteria: ReadonlyArray<CompiledCriterion>;
  readonly actions: ReadonlyArray<Action>;
  readonly options: Readonly<SearchOptions>;

  private readonly stats: PipelineStats = createStats();
  private warnedUnknownOps = new Set<string>();
  private immutableApplied = false;
  private preparedActions: PreparedAction[] | null = null;

  constructor(data: TData, options: SearchOptions = {}, criteria: CompiledCriterion[] = [], actions: Action[] = []) {
    this._data = data;
    this.options = {
      maxDepth: DEFAULT_MAX_DEPTH, includeArrays: true, includeObjects: true, earlyTermination: false,
      limit: undefined, buildMeta: true, returnPaths: true, ...options,
    };
    this.criteria = criteria;
    this.actions = actions;
  }

  with(next: { data?: TData; options?: SearchOptions; criteria?: CompiledCriterion[]; actions?: Action[] }): JsnqPipeline<TData> {
    return new JsnqPipeline<TData>(
      next.data ?? this.data,
      next.options ?? this.options,
      next.criteria ?? (this.criteria as CompiledCriterion[]),
      next.actions ?? (this.actions as Action[])
    );
  }

  immutable(mode: true | 'auto' = true): JsnqPipeline<TData> {
    return this.with({ options: { ...this.options, immutable: mode } });
  }

  dryRun(enabled: boolean = true): JsnqPipeline<TData> {
    return this.with({ options: { ...this.options, dryRun: enabled } });
  }

  pipeline(...ops: Array<JsonOperator<JsnqPipeline<TData>>>): JsnqPipeline<TData> { return this.pipe(...ops); }

  pipe(...ops: Array<JsonOperator<JsnqPipeline<TData>>>): JsnqPipeline<TData> {
    return ops.reduce<JsnqPipeline<TData>>((acc, op) => op(acc), this);
  }

  clone(): JsnqPipeline<TData> { return this.with({}); }

  first(): TData | null;
  first<T = unknown>(): T | null;
  first<T = unknown>(): T | null {
    // Runs on this instance (not a copy) so an immutable pipeline's `.data` and `getStats()` reflect the run.
    const res = this.execute({ ...this.options, earlyTermination: true });
    return res.length ? (res[0].data as unknown as T) : null;
  }

  all(): SearchResultNode<TData, unknown, string | number>[] { return this.execute(); }

  count(): number { return this.execute().length; }

  getStats(): PipelineStats {
    return { ...this.stats, warnings: [...this.stats.warnings], operations: [...this.stats.operations] };
  }

  private execute(options: Readonly<SearchOptions> = this.options): SearchResultNode<TData, unknown, string | number>[] {
    const t0 = now();
    const { stats, criteria, actions } = this;
    resetStats(stats);
    const strictCtx: StrictOperatorContext = { warnedUnknownOps: this.warnedUnknownOps, warnings: stats.warnings };
    // Criteria are analysed (and the strict-operator policy enforced) once per execute.
    const plan = planCriteria(criteria, options, strictCtx);

    try {
      const { needPaths, limit, shouldClone } = resolveRun(options, actions.length);

      // Immutable mode: clone data before traversal so iterator nodes point at the working copy.
      if (shouldClone && !this.immutableApplied) {
        this._data = cloneJson(this.data);
        this.immutableApplied = true;
      }

      const ctx = { data: this._data, options, stats };
      const rootInsert = rootArrayInsert(ctx, criteria, actions, needPaths);
      if (rootInsert) return typed<TData>(rootInsert);

      const flat = executeFlatArrayFastPath({
        data: this.data, criteria, actions, options, stats,
        warnedUnknownOps: this.warnedUnknownOps, immutableApplied: this.immutableApplied,
      });
      if (flat) {
        this._data = flat.data;
        this.immutableApplied = flat.immutableApplied;
        return flat.results;
      }

      const prepared = actions.length > 0 ? (this.preparedActions ??= prepareActions(actions)) : null;
      return typed<TData>(runSearch({ ctx, criteria, actions, plan, needPaths, limit, prepared }));
    } finally {
      stats.searchTime = now() - t0;
    }
  }
}

export default JsnqPipeline;
