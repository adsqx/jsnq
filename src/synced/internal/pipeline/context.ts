/** Shared per-execution state handed to node/global action handlers. */
import type { SearchOptions } from '../types/options';
import type { PipelineStats } from '../types/stats';

/** Counter bumped by each move/copy kind. */
export const KIND_STAT = { move: 'moved', copy: 'copied' } as const;

export interface RunCtx {
  /** Root of the working data (already cloned when immutable). */
  readonly data: unknown;
  readonly options: Readonly<SearchOptions>;
  readonly stats: PipelineStats;
}
