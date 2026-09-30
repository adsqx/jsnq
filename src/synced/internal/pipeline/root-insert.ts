/** O(1) path for `insert(x)` (position 'inside') applied straight to a root array, with no criteria. */
import type { Action } from '../types/actions';
import type { CompiledCriterion } from '../types/operators';
import type { SearchResultNode } from '../types/pipeline';
import type { RunCtx } from './context';
import { spliceClamped } from '../splice';

export function rootArrayInsert(
  { data: root, options, stats }: RunCtx,
  criteria: ReadonlyArray<CompiledCriterion>,
  actions: ReadonlyArray<Action>,
  needPaths: boolean
): SearchResultNode[] | null {
  if (!Array.isArray(root) || criteria.length !== 0 || actions.length !== 1) return null;
  const action = actions[0];
  if (action.type !== 'insert' || action.position !== 'inside') return null;
  const { data, key } = action;

  if (!options.dryRun) {
    if (typeof key === 'number') spliceClamped(root, key, data);
    else root.push(data);
  }

  stats.nodesVisited++;
  stats.resultsFound++;
  stats.inserted++;
  if (options.trackOperations !== false) stats.operations.push('insert root-array inside');

  // The reported index is the raw numeric key (unclamped), else the appended slot.
  return [{ data, path: needPaths ? [String(typeof key === 'number' ? key : Math.max(0, root.length - 1))] : undefined, depth: 1 }];
}
