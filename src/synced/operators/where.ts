import { CompiledCriterion, JsonOperator, PipelineLike, Path, PathValue, OperatorFor, BracketPath, JsonLike } from '../core/types';
import { compileCriterion } from '../core/match';

// Overloads for stronger typing (fallback to weak typing to preserve DX)
// 1) Value-sensitive operators (==, includes, etc.) with typed value
function where<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(key: P, operator: OperatorFor<PathValue<T['data'], P & string>>, value: PathValue<T['data'], P & string>): JsonOperator<T>;
// 2) Type-check operators with boolean value
function where<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(key: P, operator: 'isArray' | 'isObject', value: boolean): JsonOperator<T>;
function where<T extends PipelineLike<JsonLike>>(key: string, operator: CompiledCriterion['operator'], value: unknown): JsonOperator<T>;
function where<T extends PipelineLike<JsonLike>>(key: string, operator: CompiledCriterion['operator'], value: unknown): JsonOperator<T> {
  const fn: JsonOperator<T> = (pipeline: T) => {
    const compiled = compileCriterion(key, operator, value);
    return pipeline.with({ criteria: [...pipeline.criteria, compiled] }) as T;
  };

  // Add cache metadata for pipeline caching
  fn.__cacheKey = JSON.stringify({ op: 'where', key, operator, value });

  return fn;
}

export default where;
