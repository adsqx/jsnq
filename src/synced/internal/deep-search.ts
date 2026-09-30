/**
 * `@` deep-array search: `fields@id` finds elements of `fields` (and of nested `fields`
 * arrays inside matching or non-matching elements) whose `id` satisfies an operator;
 * `@id` tests the current node itself.
 */
import { isObject } from './guards';
import { getBySegments, splitPath } from './path-facade';

// Deep search path parsing - recognises `@` as the deep array search operator
export interface DeepSearchPath {
  isDeep: boolean;
  arrayKey?: string;      // Array key for deep search (e.g. "fields", "layout")
  searchSegments: string[]; // Path segments after `@` (e.g. ["id"] for "fields@id")
}

export function parseDeepSearchPath(path: string): DeepSearchPath {
  if (!path) return { isDeep: false, searchSegments: [] };
  const atIndex = path.indexOf('@');
  // No `@`: plain path.
  if (atIndex === -1) return { isDeep: false, searchSegments: splitPath(path) };
  // `@id`: deep search on the current node; `fields@id`: on the named array.
  return {
    isDeep: true,
    arrayKey: atIndex === 0 ? undefined : path.substring(0, atIndex),
    searchSegments: splitPath(path.substring(atIndex + 1)),
  };
}

type OpFn = (a: unknown, b: unknown) => boolean;

interface ArrayFrame {
  arr: unknown[];
  /** Path of `arr` itself; element paths append the element index. */
  basePath: string[];
  depth: number;
  nextIndex: number;
}

export interface DeepArrayMatch {
  data: unknown;
  path?: string[];
  depth: number;
  parent?: unknown;
  parentKey?: string | number;
}

/**
 * Resumable walk over `arrayKey` arrays: every element is tested against `opFn`, and object
 * elements holding a nested `arrayKey` array are descended into (arrays already on the
 * current stack are skipped to stay cycle-safe). A matched element's own nested array is
 * visited after the match is consumed. Paths are only built on demand, so a boolean
 * caller pays for none.
 */
class ArrayCursor {
  private readonly keySegments: string[];
  private readonly stack: ArrayFrame[] = [];
  private frame: ArrayFrame | undefined;
  private item: unknown;
  private index = 0;
  private itemPath: string[] | undefined;

  constructor(
    node: unknown,
    arrayKey: string,
    private readonly searchSegments: string[],
    private readonly opFn: OpFn,
    private readonly value: unknown,
    path: string[],
    depth: number,
    private readonly maxDepth: number
  ) {
    this.keySegments = splitPath(arrayKey);
    const root = getBySegments(node, this.keySegments);
    if (Array.isArray(root)) this.stack.push({ arr: root, basePath: [...path, ...this.keySegments], depth, nextIndex: 0 });
  }

  /** Advances to the next matching element; false when the walk is complete. */
  next(): boolean {
    if (this.frame) {
      // Resume after a reported match: its nested array is still to be visited.
      this.descend(this.frame, this.item, this.index);
      this.frame = undefined;
    }
    const { stack } = this;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.nextIndex >= frame.arr.length) {
        stack.pop();
        continue;
      }
      const index = frame.nextIndex++;
      const item = frame.arr[index];
      this.itemPath = undefined;
      if (this.opFn(getBySegments(item, this.searchSegments), this.value)) {
        this.frame = frame;
        this.item = item;
        this.index = index;
        return true;
      }
      this.descend(frame, item, index);
    }
    return false;
  }

  /** The element reported by the last successful `next()`. */
  match(): DeepArrayMatch {
    const frame = this.frame!;
    return { data: this.item, path: this.pathOf(frame, this.index), depth: frame.depth, parent: frame.arr, parentKey: this.index };
  }

  private pathOf(frame: ArrayFrame, index: number): string[] {
    return (this.itemPath ??= [...frame.basePath, String(index)]);
  }

  private descend(frame: ArrayFrame, item: unknown, index: number): void {
    if (frame.depth >= this.maxDepth || !isObject(item)) return;
    const nested = getBySegments(item, this.keySegments);
    if (!Array.isArray(nested) || this.stack.some((open) => open.arr === nested)) return;
    this.stack.push({ arr: nested, basePath: [...this.pathOf(frame, index), ...this.keySegments], depth: frame.depth + 1, nextIndex: 0 });
  }
}

// Deep array matching - true as soon as one element (or nested element) matches
export function deepArrayMatch(
  node: unknown,
  arrayKey: string | undefined,
  searchSegments: string[],
  opFn: (a: unknown, b: unknown) => boolean,
  value: unknown,
  maxDepth: number = Number.POSITIVE_INFINITY
): boolean {
  // `@id` form: the node itself is the only candidate.
  if (!arrayKey) return !!opFn(getBySegments(node, searchSegments), value);
  return new ArrayCursor(node, arrayKey, searchSegments, opFn, value, [], 0, maxDepth).next();
}

// Deep array iterator - yield all matching elements from nested arrays
export function* deepArrayIterator(
  node: unknown,
  arrayKey: string | undefined,
  searchSegments: string[],
  opFn: (a: unknown, b: unknown) => boolean,
  value: unknown,
  path: string[] = [],
  depth: number = 0,
  maxDepth: number = Number.POSITIVE_INFINITY
): Generator<{ data: unknown; path?: string[]; depth: number; parent?: unknown; parentKey?: string | number }> {
  if (!arrayKey) {
    // @id - yield node itself if matches
    if (opFn(getBySegments(node, searchSegments), value)) yield { data: node, path, depth };
    return;
  }
  const cursor = new ArrayCursor(node, arrayKey, searchSegments, opFn, value, path, depth, maxDepth);
  while (cursor.next()) yield cursor.match();
}
