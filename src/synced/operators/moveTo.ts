import { InsertPosition, JsonOperator, PipelineLike, Path, PathValue, KeyFor, BracketPath, JsonLike } from '../core/types';
import { ModeKeyOptions, positionOperator } from './shared';

type MoveToOptions = ModeKeyOptions;
const impl = positionOperator('move');

// Typed overloads restrict the key type by the target path's value
function moveTo<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(position: P, mode?: InsertPosition, key?: KeyFor<PathValue<T['data'], P & string>>): JsonOperator<T>;
function moveTo<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(position: P, opts: { mode?: InsertPosition; key?: KeyFor<PathValue<T['data'], P & string>> }): JsonOperator<T>;
function moveTo<T extends PipelineLike>(position: string, modeOrOpts?: InsertPosition | MoveToOptions, key?: string | number): JsonOperator<T>;
function moveTo<T extends PipelineLike>(position: string, modeOrOpts: InsertPosition | MoveToOptions = 'inside', key?: string | number): JsonOperator<T> {
  return impl(position, modeOrOpts, key);
}

export default moveTo;
