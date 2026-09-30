/** Path-string and JSON value typing helpers (type-level only, no runtime). */

// Stronger typing helpers (optional, non-breaking)
export type Primitive = string | number | boolean | null | undefined;
export type JsonLike = Primitive | JsonLike[] | { [k: string]: JsonLike };

// Build path strings for object/array structures
// Supports:
//  - dot notation: users.0.name
//  - bracket index notation for arrays: users[0].name
// To avoid TS "excessively deep" errors, use a depth-limited recursion helper.
type _Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// Helper types for path construction
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

// Public default: depth 6 (tunable via advanced alias below)
export type Path<T> = PathRec<T, 6>;
export type PathWithDepth<T, D extends number> = PathRec<T, D>;

// Split a string type by '.'
export type Split<S extends string> = S extends `${infer A}.${infer B}` ? [A, ...Split<B>] : [S];

// Helper types for path value resolution
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

// Resolve value type at given path
// PathValue recursion is naturally bounded by P's length, so no explicit depth cap needed
type PathValueRec<T, P extends string> =
  P extends `${infer K}.${infer R}`
    ? PathValueArrayCase<T, K, R>
    : P extends `${infer K}`
      ? PathValueBaseCase<T, K>
      : unknown;

export type PathValue<T, P extends string> = PathValueRec<T, P>;

// Helper for key type by target value type
export type KeyFor<V> = V extends ReadonlyArray<unknown> | unknown[] ? number : string;

// Bracket-path type support (array indexes as [number])
type BracketPathRec<T, D extends number> =
  T extends ReadonlyArray<infer U> | (infer U)[]
    ? `[${number}]` | (D extends 0 ? never : `[${number}].${BracketPathRec<U, _Prev[D]>}`)
    : T extends object
      ? { [K in Extract<keyof T, string>]: `${K}` | (D extends 0 ? never : `${K}.${BracketPathRec<T[K], _Prev[D]>}`) }[Extract<keyof T, string>]
      : never;

export type BracketPath<T> = BracketPathRec<T, 6>;
export type BracketPathWithDepth<T, D extends number> = BracketPathRec<T, D>;
