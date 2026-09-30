import JsnqPipeline from './pipeline';
import { JsonOperator, JsonLike } from './types';
import { cloneJsonData } from './data-engine';

type Readable = Pick<JsnqPipeline, 'all' | 'count'> & { first(): unknown };

/** How each `execute(mode)` reads a pipeline; unknown modes fall back to `all`. */
const RUN = {
  all: (p: Readable): unknown => p.all(),
  first: (p: Readable): unknown => p.first(),
  count: (p: Readable): unknown => p.count(),
};

/**
 * JsnqPipeline wrapper with auto-immutability for zoneless change detection:
 * `const w = new PipelineWrapper(data); w.pipeline(where(...), update(...)).execute(); store = w.data;`
 */
export class PipelineWrapper<T extends JsonLike = JsonLike> {
  private _pipeline: JsnqPipeline<T>;

  constructor(data: T, options?: { autoClone?: boolean; trackOperations?: boolean }) {
    // Auto-clone by default for immutability
    const clonedData = (options?.autoClone !== false) ? cloneJsonData(data) : data;
    this._pipeline = new JsnqPipeline(clonedData as T, { trackOperations: options?.trackOperations ?? true });
  }

  /** Apply pipeline operators. */
  pipeline(...ops: Array<JsonOperator<JsnqPipeline<T>>>): this {
    this._pipeline = ops.reduce((acc, op) => op(acc), this._pipeline);
    return this;
  }

  /** Execute the pipeline (`all` by default). */
  execute(mode: 'all' | 'first' | 'count' = 'all'): unknown {
    return (Object.hasOwn(RUN, mode) ? RUN[mode] : RUN.all)(this._pipeline);
  }

  /** The mutated data (a clone when autoClone was true). */
  get data(): T {
    return this._pipeline.data;
  }

  /** Pipeline stats. */
  get stats() {
    return this._pipeline.getStats();
  }
}
