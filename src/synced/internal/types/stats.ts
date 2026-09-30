/** Pipeline run statistics and the minimal warning-sink shape used by ops helpers. */

export interface PipelineStats {
  searchTime: number;
  nodesVisited: number;
  resultsFound: number;
  maxDepth: number;
  // extended metrics (required to simplify usage without casts)
  replaces: number;
  updates: number;
  mergeUpdates: number;
  deletedKeys: number;
  deletedElements: number;
  inserted: number;
  moved: number;
  copied: number;
  warnings: string[];
  operations: string[];
}

/** Minimal sink for non-fatal warnings; `PipelineStats` satisfies it. */
export interface WarnSink { warnings: string[] }
