import { CompiledCriterion, JsonOperator, PipelineLike, Path, PathValue, OperatorFor, BracketPath, JsonLike } from '../core/types';
import { compileCriterion } from '../core/match';

// Typed overloads (value-sensitive operators, then type-check operators), with a weakly typed fallback
function where<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(key: P, operator: OperatorFor<PathValue<T['data'], P & string>>, value: PathValue<T['data'], P & string>): JsonOperator<T>;
function where<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(key: P, operator: 'isArray' | 'isObject', value: boolean): JsonOperator<T>;
function where<T extends PipelineLike<JsonLike>>(key: string, operator: CompiledCriterion['operator'], value: unknown): JsonOperator<T>;
function where<T extends PipelineLike<JsonLike>>(key: string, operator: CompiledCriterion['operator'], value: unknown): JsonOperator<T> {
  // compileCriterion runs at operator application (not at where() call), so its throws keep their timing
  const fn: JsonOperator<T> = (pipeline: T) => pipeline.with({ criteria: [...pipeline.criteria, compileCriterion(key, operator, value)] }) as T;
  fn.__cacheKey = JSON.stringify({ op: 'where', key, operator, value });
  return fn;
}

export default where;
