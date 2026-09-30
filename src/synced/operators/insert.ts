import { InsertPosition, JsonOperator, PipelineLike } from '../core/types';
import { isObject } from '../internal/guards';
import { mutationAction } from './shared';

type InsertOptions = { key?: string | number };

const insert = <T extends PipelineLike>(data: unknown, position: InsertPosition = 'inside', keyOrOpts?: string | number | InsertOptions): JsonOperator<T> => {
  const key = isObject(keyOrOpts) ? keyOrOpts.key : keyOrOpts;
  return mutationAction({ type: 'insert', data, position, key });
};

export default insert;
