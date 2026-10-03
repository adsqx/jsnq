/**
 * Dot paths: the strict path syntax of the signal stores (identifier keys and indexes joined by dots,
 * `a[0]` accepted as `a.0`), shared so every store parses, validates and walks paths the same way.
 * Public via core/data-engine.
 */
import { isNumericSegment } from '../guards';

const BRACKET_RE = /\[(.*?)\]/g;
const DOT_PATH_RE = /^[a-zA-Z_$][\w$]*(\.[\w$]+)*$/;
const FORBIDDEN_DOT_RE = /(?:^|\.)(?:__proto__|prototype|constructor)(?:\.|$)/;

/**
 * Bounded string-keyed cache with generational eviction: lookups check `current` then `previous`
 * (promoting a hit); on overflow `current` becomes `previous`. O(1) per insert, unlike evicting the
 * oldest Map entry through a fresh iterator. Values must never be `undefined`.
 */
class GenerationalCache<V> {
  private current = new Map<string, V>();
  private previous = new Map<string, V>();
  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    const hit = this.current.get(key);
    if (hit !== undefined) return hit;
    const stale = this.previous.get(key);
    if (stale !== undefined) this.current.set(key, stale);
    return stale;
  }

  set(key: string, value: V): V {
    this.current.set(key, value);
    if (this.current.size > this.limit) {
      this.previous = this.current;
      this.current = new Map();
    }
    return value;
  }

  clear(): void {
    this.current = new Map();
    this.previous = new Map();
  }
}

const bracketCache = new GenerationalCache<string>(5000);
const segmentsCache = new GenerationalCache<readonly string[]>(5000);
const validCache = new GenerationalCache<boolean>(5000);

/** Drops the cached normalizations, splits and validity results. */
export function clearDotPathCaches(): void {
  bracketCache.clear();
  segmentsCache.clear();
  validCache.clear();
}

/** Bracket indexes to dots (`users[0].name` -> `users.0.name`); `''` for an empty path. Only bracket paths are cached: a dot path is returned as is. */
export function normalizeDotPath(path: string): string {
  if (!path) return '';
  if (path.indexOf('[') === -1) return path;
  return bracketCache.get(path) ?? bracketCache.set(path, path.replace(BRACKET_RE, '.$1'));
}

/** Segments of a normalized path, cached (`''` -> `[]`). Shared arrays: never mutate them. */
export function splitDotPath(normalized: string): readonly string[] {
  if (!normalized) return [];
  return segmentsCache.get(normalized) ?? segmentsCache.set(normalized, normalized.split('.'));
}

/** A normalized path made of identifier / index segments, none of them `__proto__` / `prototype` / `constructor`. */
export function isValidNormalizedDotPath(normalized: string): boolean {
  return typeof normalized === 'string' && DOT_PATH_RE.test(normalized) && !FORBIDDEN_DOT_RE.test(normalized);
}

/** {@link isValidNormalizedDotPath} after normalization, cached per raw path. */
export function isValidDotPath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  return validCache.get(path) ?? validCache.set(path, isValidNormalizedDotPath(normalizeDotPath(path)));
}

/** `path` normalized, or null when it is empty or invalid. */
function validNormalized(path: string): string | null {
  if (!path || typeof path !== 'string') return null;
  const normalized = normalizeDotPath(path);
  return isValidNormalizedDotPath(normalized) ? normalized : null;
}

/** Parent of a normalized path without re-validating it; null for a top-level key. */
export function dotPathParent(normalized: string): string | null {
  const index = normalized.lastIndexOf('.');
  return index === -1 ? null : normalized.slice(0, index);
}

/** Path of the container above the first index segment (`tree.0.fields` -> `tree`); null when there is none. */
export function dotPathIndexContainer(path: string): string | null {
  const normalized = validNormalized(path);
  if (normalized === null) return null;
  const parts = normalized.split('.');
  const index = parts.findIndex(isNumericSegment);
  return index > 0 ? parts.slice(0, index).join('.') : null;
}

/** Ancestor-or-self paths, deepest first (`a.0.b` -> `a.0.b`, `a.0`, `a`); empty for an invalid path. */
export function dotPathAncestors(path: string): string[] {
  const normalized = validNormalized(path);
  if (normalized === null) return [];
  const out: string[] = [];
  for (let end = normalized.length; end > 0; end = normalized.lastIndexOf('.', end - 1)) out.push(normalized.slice(0, end));
  return out;
}

export interface DependencyPathOptions {
  /** 'container' tracks the parent of a valid path instead of the path itself. */
  dependencyMode: 'exact' | 'container';
  /** Track the container above the first index segment (so any item change wakes the list). */
  bumpNumericParent: boolean;
}

/** The path a reactive store tracks for a read or write of `normalized`. */
export function resolveDependencyPath(normalized: string, options: DependencyPathOptions): string {
  const parent = options.dependencyMode === 'container' && isValidNormalizedDotPath(normalized) ? dotPathParent(normalized) : null;
  const base = parent ?? normalized;
  return options.bumpNumericParent ? dotPathIndexContainer(base) ?? base : base;
}
