import { JsonOperator, PipelineLike, UpdateAction, Path, PathValue, BracketPath, JsonLike } from '../core/types';
import { mutationAction } from './shared';

function update<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(key: P, value: PathValue<T['data'], P & string> | ((current: PathValue<T['data'], P & string>, node: T['data']) => PathValue<T['data'], P & string>)): JsonOperator<T>;
function update<T extends PipelineLike<JsonLike>>(key: string, value: UpdateAction['value']): JsonOperator<T>;
function update<T extends PipelineLike<JsonLike>>(key: string, value: UpdateAction['value']): JsonOperator<T> {
  return mutationAction<T>({ type: 'update', key, value });
}

export default update;
