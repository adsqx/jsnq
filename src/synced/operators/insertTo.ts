import { InsertPosition, JsonOperator, PipelineLike, Path, PathValue, KeyFor, BracketPath, JsonLike } from '../core/types';
import { ModeKeyOptions, mutationAction, normalizeModeKeyOptions } from './shared';

type InsertToOptions = ModeKeyOptions;

// Typed overloads restrict the key type by the target path's value
function insertTo<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(position: P, data: unknown, mode?: InsertPosition, key?: KeyFor<PathValue<T['data'], P & string>>): JsonOperator<T>;
function insertTo<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(position: P, data: unknown, opts: { mode?: InsertPosition; key?: KeyFor<PathValue<T['data'], P & string>> }): JsonOperator<T>;
function insertTo<T extends PipelineLike>(position: string, data: unknown, modeOrOpts?: InsertPosition | InsertToOptions, key?: string | number): JsonOperator<T>;
function insertTo<T extends PipelineLike>(position: string, data: unknown, modeOrOpts: InsertPosition | InsertToOptions = 'inside', key?: string | number): JsonOperator<T> {
  const opts = normalizeModeKeyOptions(modeOrOpts, key);
  return mutationAction({ type: 'insert_to', position, data, mode: opts.mode ?? 'inside', key: opts.key });
}

export default insertTo;
