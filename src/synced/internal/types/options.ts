/** Pipeline option types. */

// Array merge strategies for deep merge operations
export type ArrayMergeStrategy = 'replace' | 'concat' | 'merge-by-key';

export interface SearchOptions {
  maxDepth?: number;
  includeArrays?: boolean;
  includeObjects?: boolean;
  earlyTermination?: boolean;
  limit?: number;
  buildMeta?: boolean;
  returnPaths?: boolean;
  immutable?: boolean | 'auto'; // true or 'auto' (clone only if there are mutating actions)
  dryRun?: boolean;    // don't mutate; only collect planned operations and stats
  strictPathsWarn?: boolean; // add warnings on implicit path creation or missing segments
  operatorsStrict?: 'warn' | 'throw'; // behavior for unknown comparison operators
  // Deep merge array behavior
  arrayMergeStrategy?: ArrayMergeStrategy; // default: 'replace'
  arrayMergeKey?: string | ((x: unknown) => string | number); // required when strategy = 'merge-by-key'
  // Overwrite behavior when inserting into object targets
  overwritePolicy?: 'overwrite' | 'skip' | 'error'; // default: 'overwrite'
  warnOnOverwrite?: boolean; // default: true
  // Warn that before/after on objects has no stable order semantics
  objectOrderWarning?: boolean; // default: true
  /**
   * When false, skips `stats.operations.push(...)` in hot paths. The `operations` array
   * stays initialized (empty) but no string allocation/push happens per action. Default
   * true (preserves public stats API). Host commit fast paths set this to false since
   * they never inspect operation labels — removes O(matches × actions) string allocations
   * from the mutate hot path.
   */
  trackOperations?: boolean; // default: true
}
