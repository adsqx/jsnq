/** Comparison-operator and compiled-criterion types. */

export type ComparisonOperator =
  | '=='
  | '==='
  | '!='
  | '!=='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'includes'
  | '!includes'
  | 'startsWith'
  | 'endsWith'
  | 'regex'
  | 'isArray'
  | 'isObject'
  | (string & {});

// Narrow built-in operators by value type (keeps registry extensibility)
export type EqualityOps = '==' | '===' | '!=' | '!==';
export type NumericOps = EqualityOps | '<' | '<=' | '>' | '>=';
export type StringOps = EqualityOps | 'includes' | '!includes' | 'startsWith' | 'endsWith' | 'regex';
export type ArrayOps = EqualityOps | 'includes' | '!includes';

// Helper types for operator combinations
export type ComparisonOps = EqualityOps | '<' | '<=' | '>' | '>=';
export type PatternOps = 'includes' | '!includes' | 'startsWith' | 'endsWith' | 'regex';
export type TypeCheckOps = 'isArray' | 'isObject';

export type OperatorFor<V> =
  V extends number ? ComparisonOps | PatternOps :
  V extends string ? ComparisonOps | PatternOps :
  V extends boolean ? EqualityOps :
  V extends ReadonlyArray<unknown> | unknown[] ? ComparisonOps | PatternOps :
  EqualityOps | TypeCheckOps | (string & {});

export interface CompiledCriterion {
  segments: string[];
  operator: ComparisonOperator;
  value: unknown;
  opFn: (a: unknown, b: unknown) => boolean;
  knownOperator: boolean;
  // Deep array search support
  isDeep?: boolean;
  deepArrayKey?: string;  // nazwa klucza tablicy dla deep search (np. "fields", "layout")
}

