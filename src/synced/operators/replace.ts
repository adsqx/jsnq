import { JsonOperator, PipelineLike, ReplaceAction, Path, PathValue, BracketPath, JsonLike } from '../core/types';
import { mutationAction } from './shared';

function replace<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(key: P, value: PathValue<T['data'], P & string> | ((current: PathValue<T['data'], P & string>, node: T['data']) => PathValue<T['data'], P & string>)): JsonOperator<T>;
function replace<T extends PipelineLike<JsonLike>>(key: string, value: ReplaceAction['value']): JsonOperator<T>;
function replace<T extends PipelineLike<JsonLike>>(key: string, value: ReplaceAction['value']): JsonOperator<T> {
  return mutationAction<T>({ type: 'replace', key, value });
}

export default replace;
