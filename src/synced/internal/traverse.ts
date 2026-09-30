/**
 * Iterative DFS over JSON values. Two consumers share one traversal state:
 * - `scanJsonMatches`: callback-driven match collection with allocation-light stacks;
 * - `dfsIterator`: generator that yields a frame for every visited value.
 * Both visit nodes in the same pre-order (arrays by index, objects by key order).
 */
import { isObject } from './guards';

export type TraverseFrame<TNode = unknown, TParent = unknown, TKey extends string | number = string | number> = {
  data: TNode;
  path?: string[];
  depth: number;
  parent?: TParent;
  parentKey?: TKey;
};

export interface ScanJsonOptions {
  maxDepth: number;
  includeArrays: boolean;
  includeObjects: boolean;
  buildMeta: boolean;
  returnPaths: boolean;
}

/**
 * Parallel-array DFS stack. Parent/key stacks are only filled when `buildMeta` is set and
 * the segment stack only when `returnPaths` is set (an empty stack pops `undefined`), so
 * callers pay solely for the data they asked for. After `next()` returns true the current
 * node's state is readable from the public fields.
 */
class Walk {
  node: unknown = undefined;
  depth = 0;
  parent: unknown = undefined;
  parentKey: string | number | undefined = undefined;
  private readonly nodes: unknown[];
  private readonly depths: number[] = [0];
  private readonly parents: unknown[] = [];
  private readonly keys: Array<string | number | undefined> = [];
  private readonly segments: string[] = [];
  private readonly pathBuffer: string[] = [];
  private readonly maxDepth: number;
  private readonly arrays: boolean;
  private readonly objects: boolean;
  private readonly meta: boolean;
  private readonly paths: boolean;

  constructor(data: unknown, o: ScanJsonOptions) {
    this.nodes = [data];
    this.maxDepth = o.maxDepth;
    this.arrays = o.includeArrays;
    this.objects = o.includeObjects;
    this.meta = o.buildMeta;
    this.paths = o.returnPaths;
    if (o.buildMeta) { this.parents.push(undefined); this.keys.push(undefined); }
    if (o.returnPaths) this.segments.push('');
  }

  /** Pops the next node into the public fields; false once the stack is exhausted. */
  next(): boolean {
    if (this.nodes.length === 0) return false;
    this.node = this.nodes.pop();
    const depth = this.depths.pop()!;
    this.depth = depth;
    if (this.meta) {
      this.parent = this.parents.pop();
      this.parentKey = this.keys.pop();
    }
    if (this.paths) {
      const segment = this.segments.pop()!;
      if (depth === 0) {
        this.pathBuffer.length = 0;
      } else {
        this.pathBuffer[depth - 1] = segment;
        this.pathBuffer.length = depth; // drop stale deeper segments from prior branches
      }
    }
    return true;
  }

  /** Pushes the children of the current node (reverse order so pops run in document order). */
  expand(): void {
    const { node, depth } = this;
    if (depth >= this.maxDepth) return;
    if (Array.isArray(node) && this.arrays) {
      for (let index = node.length - 1; index >= 0; index--) this.push(node[index], depth + 1, node, index, String(index));
    } else if (isObject(node) && this.objects) {
      const keys = Object.keys(node);
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index]!;
        this.push(node[key], depth + 1, node, key, key);
      }
    }
  }

  /** Fresh frame for the current node; `path` is an owned copy of the shared buffer. */
  frame(): TraverseFrame {
    return {
      data: this.node,
      path: this.paths ? this.pathBuffer.slice(0, this.depth) : undefined,
      depth: this.depth,
      parent: this.meta ? this.parent : undefined,
      parentKey: this.meta ? this.parentKey : undefined,
    };
  }

  private push(node: unknown, depth: number, parent: unknown, key: string | number, segment: string): void {
    this.nodes.push(node);
    this.depths.push(depth);
    if (this.meta) { this.parents.push(parent); this.keys.push(key); }
    if (this.paths) this.segments.push(segment);
  }
}

/**
 * Allocation-light DFS for match collection. Stack state is stored in parallel
 * arrays and result nodes are created only for matches, unlike the generator
 * contract which must allocate a frame for every visited value.
 */
export function scanJsonMatches(
  data: unknown,
  options: ScanJsonOptions,
  predicate: (node: unknown) => boolean,
  onMatch: (node: TraverseFrame) => boolean | void
): { nodesVisited: number; maxDepth: number; stopped: boolean } {
  let nodesVisited = 0;
  let observedMaxDepth = 0;
  if (!options.buildMeta && !options.returnPaths) {
    // Hot loop: only data + depth stacks, result frames are `{ data, depth }`.
    const { maxDepth, includeArrays, includeObjects } = options;
    const nodes: unknown[] = [data];
    const depths: number[] = [0];
    while (nodes.length > 0) {
      const node = nodes.pop();
      const depth = depths.pop()!;
      nodesVisited++;
      if (depth > observedMaxDepth) observedMaxDepth = depth;
      if (predicate(node) && onMatch({ data: node, depth }) === false) {
        return { nodesVisited, maxDepth: observedMaxDepth, stopped: true };
      }
      if (depth >= maxDepth) continue;
      const nextDepth = depth + 1;
      if (Array.isArray(node) && includeArrays) {
        for (let index = node.length - 1; index >= 0; index--) {
          nodes.push(node[index]);
          depths.push(nextDepth);
        }
      } else if (isObject(node) && includeObjects) {
        const keys = Object.keys(node);
        for (let index = keys.length - 1; index >= 0; index--) {
          nodes.push(node[keys[index]!]);
          depths.push(nextDepth);
        }
      }
    }
    return { nodesVisited, maxDepth: observedMaxDepth, stopped: false };
  }

  const walk = new Walk(data, options);
  while (walk.next()) {
    nodesVisited++;
    if (walk.depth > observedMaxDepth) observedMaxDepth = walk.depth;
    if (predicate(walk.node) && onMatch(walk.frame()) === false) {
      return { nodesVisited, maxDepth: observedMaxDepth, stopped: true };
    }
    walk.expand();
  }
  return { nodesVisited, maxDepth: observedMaxDepth, stopped: false };
}

export function* dfsIterator<TNode = unknown, TParent = unknown, TKey extends string | number = string | number>(
  data: TNode,
  options: { maxDepth: number; includeArrays: boolean; includeObjects: boolean; buildMeta: boolean; returnPaths: boolean; shouldDescend?: (frame: TraverseFrame<TNode, TParent, TKey>) => boolean }
): Generator<TraverseFrame<TNode, TParent, TKey>> {
  const { shouldDescend } = options;
  const walk = new Walk(data, options);
  while (walk.next()) {
    // The root is always yielded, deeper frames are never pushed past maxDepth.
    if (walk.depth > options.maxDepth) continue;
    // Frames are typed unknown internally; TNode/TParent/TKey are the caller's view of the same values.
    const frame = walk.frame() as TraverseFrame<TNode, TParent, TKey>;
    yield frame;
    if (shouldDescend && shouldDescend(frame) === false) continue;
    walk.expand();
  }
}
