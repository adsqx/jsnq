import { CompiledCriterion, JsonOperator, PipelineLike, Path, PathValue, OperatorFor, BracketPath, JsonLike } from '../core/types';
import { compileCriterion } from '../core/match';

/** A plain predicate over a node (or over the value at `key`). Returns true to select the node. */
export type WherePredicate<V = unknown> = (value: V) => boolean;

// The predicate form is a criterion with no segments (it receives the node itself, or the value at
// `key`); it has no `__cacheKey`, so hosts key their caches by function identity instead of by a
// JSON of the function (which would make every predicate collide).
const predicateCriterion = (key: string, predicate: WherePredicate): CompiledCriterion => ({
  ...compileCriterion(key, 'satisfies', predicate),
  opFn: (actual, fn) => (fn as WherePredicate)(actual),
  knownOperator: true,
});

// Typed overloads (value-sensitive operators, then type-check operators), then the predicate forms,
// with a weakly typed fallback
function where<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(key: P, operator: OperatorFor<PathValue<T['data'], P & string>>, value: PathValue<T['data'], P & string>): JsonOperator<T>;
function where<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(key: P, operator: 'isArray' | 'isObject', value: boolean): JsonOperator<T>;
function where<T extends PipelineLike<JsonLike>, P extends Path<T['data']> | BracketPath<T['data']>>(key: P, predicate: WherePredicate<PathValue<T['data'], P & string>>): JsonOperator<T>;
// Criteria run against every node, so a relative key is not a root path: annotate the parameter
// (`(score: number) => …`, `(u: User) => …`) to type it; unannotated it is `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function where<T extends PipelineLike<JsonLike>, V = any>(predicate: WherePredicate<V>): JsonOperator<T>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function where<T extends PipelineLike<JsonLike>, V = any>(key: string, predicate: WherePredicate<V>): JsonOperator<T>;
function where<T extends PipelineLike<JsonLike>>(key: string, operator: CompiledCriterion['operator'], value: unknown): JsonOperator<T>;
function where<T extends PipelineLike<JsonLike>>(
  keyOrPredicate: string | WherePredicate<never>,
  operatorOrPredicate?: CompiledCriterion['operator'] | WherePredicate<never>,
  value?: unknown
): JsonOperator<T> {
  if (typeof keyOrPredicate === 'function' || typeof operatorOrPredicate === 'function') {
    const key = typeof keyOrPredicate === 'string' ? keyOrPredicate : '';
    const predicate = (typeof keyOrPredicate === 'function' ? keyOrPredicate : operatorOrPredicate) as WherePredicate;
    return (pipeline: T) => pipeline.with({ criteria: [...pipeline.criteria, predicateCriterion(key, predicate)] }) as T;
  }
  const key = keyOrPredicate;
  const operator = operatorOrPredicate as CompiledCriterion['operator'];
  // compileCriterion runs at operator application (not at where() call), so its throws keep their timing
  const fn: JsonOperator<T> = (pipeline: T) => pipeline.with({ criteria: [...pipeline.criteria, compileCriterion(key, operator, value)] }) as T;
  fn.__cacheKey = JSON.stringify({ op: 'where', key, operator, value });
  return fn;
}

export default where;
