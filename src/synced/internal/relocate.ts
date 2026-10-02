import type { Action, InsertPosition } from './types/actions';
import type { ComparisonOperator, JsonOperator, PipelineLike } from './types/model';
import { mutationAction } from '../operators/shared';

/**
 * Where `move()` / `copy()` put the matched nodes: a path, or the node(s) selected by a criterion.
 * `into: 'first'` (default) targets the first selected node in traversal order, `'all'` every one
 * of them (extra targets receive clones).
 */
export type RelocateTarget =
  | string
  | { where: readonly [key: string, operator: ComparisonOperator, value: unknown]; into?: 'first' | 'all' };

export interface RelocateOptions {
  /** Where relative to the target: inside it (default), or before/after it in its parent array. */
  mode?: InsertPosition;
  /** Key to use when inserting into an object. */
  key?: string | number;
  /** `move()` with a `where` target only: write into `target[overwrite]`, replacing what is there. */
  overwrite?: string;
}

const MATCH_TYPES = {
  move: { first: 'move_matches', all: 'move_first_to_matches' },
  copy: { first: 'copy_matches', all: 'copy_first_to_matches' },
} as const;

/** One entry point per verb, mapped onto the long-standing action types. */
export const relocate = (verb: 'move' | 'copy') =>
  <T extends PipelineLike>(to: RelocateTarget, opts: RelocateOptions = {}): JsonOperator<T> => {
    const { mode, key, overwrite } = opts;
    if (typeof to === 'string') {
      if (overwrite !== undefined) throw new Error(`jsnq ${verb}(): 'overwrite' needs a { where } target`);
      return mutationAction({ type: verb, position: to, mode: mode ?? 'inside', key });
    }
    const [targetKey, targetOperator, targetValue] = to.where;
    if (overwrite !== undefined) {
      if (verb === 'copy') throw new Error("jsnq copy(): 'overwrite' is only supported by move()");
      if (to.into === 'all') throw new Error("jsnq move(): 'overwrite' cannot be combined with into: 'all'");
      return mutationAction({ type: 'move_matches_overwrite', targetKey, targetOperator, targetValue, overwriteKey: overwrite });
    }
    const type = MATCH_TYPES[verb][to.into ?? 'first'];
    return mutationAction({ type, targetKey, targetOperator, targetValue, mode: mode ?? 'inside', key } as Action);
  };
