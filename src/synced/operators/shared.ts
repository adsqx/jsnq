import { Action, ActionType, ComparisonOperator, InsertPosition, JsonOperator, PipelineLike } from '../core/types';
import { isObject } from '../internal/guards';

export type ModeKeyOptions<TKey extends string | number = string | number> = {
  mode?: InsertPosition;
  key?: TKey;
};

export const normalizeModeKeyOptions = <TKey extends string | number>(
  modeOrOpts: InsertPosition | ModeKeyOptions<TKey> | undefined,
  fallbackKey?: TKey
): ModeKeyOptions<TKey> => (isObject(modeOrOpts) ? modeOrOpts : { mode: modeOrOpts, key: fallbackKey });

export const appendAction = <T extends PipelineLike, TAction extends Action>(
  pipeline: T,
  action: TAction
): T => pipeline.with({ actions: [...pipeline.actions, action] }) as T;

/** Wrap an action as a pipeline operator flagged as a mutation. */
export const mutationAction = <T extends PipelineLike>(action: Action): JsonOperator<T> => {
  const operator: JsonOperator<T> = (pipeline: T) => appendAction(pipeline, action);
  operator.__isMutation = true;
  return operator;
};

/** Factory for the move/copy "matches" family: one (targetKey, targetOperator, targetValue, mode?, key?) signature, varying action type / default mode. */
export const targetMatchesOperator = (type: ActionType, defaultMode?: InsertPosition) =>
  <T extends PipelineLike>(
    targetKey: string,
    targetOperator: ComparisonOperator,
    targetValue: unknown,
    mode: InsertPosition | undefined = defaultMode,
    key?: string | number
  ): JsonOperator<T> =>
    mutationAction({ type, targetKey, targetOperator, targetValue, mode, key } as Action);

/** Factory for moveTo/copyTo: (position, modeOrOpts?, key?) with options-object support. */
export const positionOperator = (type: 'move' | 'copy') =>
  <T extends PipelineLike>(
    position: string,
    modeOrOpts: InsertPosition | ModeKeyOptions = 'inside',
    key?: string | number
  ): JsonOperator<T> => {
    const opts = normalizeModeKeyOptions(modeOrOpts, key);
    return mutationAction({ type, position, mode: opts.mode ?? 'inside', key: opts.key });
  };
