/** Path-string and JSON value typing helpers (type-level only, no runtime). */

export type Primitive = string | number | boolean | null | undefined;
export type JsonLike = Primitive | JsonLike[] | { [k: string]: JsonLike };

/** Deep-mutable view of `T`: strips `readonly`, recurses into objects and arrays; functions and primitives as is. */
export type Draft<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? Draft<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Draft<T[K]> }
      : T;

// Path strings for object/array structures: dot notation (users.0.name) and bracket indexes (users[0].name).
// Depth-limited recursion avoids TS "excessively deep" errors.
type _Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

type ArrayPathSegment<D extends number> = `${number}` | `[${number}]`;
type NestedArrayPath<T, D extends number> = D extends 0 ? never : `${number}.${PathRec<T, _Prev[D]>}` | `[${number}].${PathRec<T, _Prev[D]>}`;
type ObjectPathSegment<K extends string, V, D extends number> = `${K}` | (D extends 0 ? never : `${K}.${PathRec<V, _Prev[D]>}`);

type PathRec<T, D extends number> =
  T extends ReadonlyArray<infer U> | (infer U)[]
    ? // array: numeric or bracketed index, optionally followed by nested path
      ArrayPathSegment<D> | NestedArrayPath<U, D>
    : T extends object
      ? // object: key or nested key
        { [K in Extract<keyof T, string>]: ObjectPathSegment<K, T[K], D> }[Extract<keyof T, string>]
      : never;

// Public default: depth 6 (tunable via PathWithDepth)
export type Path<T> = PathRec<T, 6>;
export type PathWithDepth<T, D extends number> = PathRec<T, D>;

// Split a string type by '.'
export type Split<S extends string> = S extends `${infer A}.${infer B}` ? [A, ...Split<B>] : [S];

type PathValueArrayCase<T, K extends string, R extends string> = K extends `${number}`
  ? T extends ReadonlyArray<infer U> | (infer U)[]
    ? PathValueRec<U, R>
    : unknown
  : K extends keyof T
    ? PathValueRec<T[K], R>
    : unknown;

type PathValueBaseCase<T, K extends string> = K extends `${number}`
  ? T extends ReadonlyArray<infer U> | (infer U)[] ? U : unknown
  : K extends keyof T ? T[K] : unknown;

// PathValue recursion is bounded by P's length, so no explicit depth cap is needed.
type PathValueRec<T, P extends string> =
  P extends `${infer K}.${infer R}`
    ? PathValueArrayCase<T, K, R>
    : P extends `${infer K}`
      ? PathValueBaseCase<T, K>
      : unknown;

export type PathValue<T, P extends string> = PathValueRec<T, P>;

export type KeyFor<V> = V extends ReadonlyArray<unknown> | unknown[] ? number : string;

// Bracket-path variant (array indexes as [number])
type BracketPathRec<T, D extends number> =
  T extends ReadonlyArray<infer U> | (infer U)[]
    ? `[${number}]` | (D extends 0 ? never : `[${number}].${BracketPathRec<U, _Prev[D]>}`)
    : T extends object
      ? { [K in Extract<keyof T, string>]: `${K}` | (D extends 0 ? never : `${K}.${BracketPathRec<T[K], _Prev[D]>}`) }[Extract<keyof T, string>]
      : never;

export type BracketPath<T> = BracketPathRec<T, 6>;
export type BracketPathWithDepth<T, D extends number> = BracketPathRec<T, D>;
