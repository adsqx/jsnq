/** Target selection for move/copy fan-out: absolute `$` paths or a criterion over traversed nodes. */
import type { ComparisonOperator } from './types/operators';
import type { SearchOptions } from './types/options';
import type { SearchResultNode } from './types/pipeline';
import { isNumericSegment } from './guards';
import { resolveTraversal, type Traversal } from './run-options';
import { dfsIterator, scanJsonMatches, splitPath, getBySegments, hasPath } from '../core/utils';
import { getOperatorFn } from '../core/operators-registry';
import { compileCriterion } from '../core/match';
import { compileCriteriaPredicate } from '../core/compiled-predicate';

/** Nodes at an absolute path (`$.a.b[0].items`, `*` matches any one segment). */
function selectAbsolute(root: unknown, traversal: Traversal, targetKey: string): SearchResultNode[] {
  const abs = targetKey.startsWith('$.') ? targetKey.slice(2) : targetKey.slice(1);
  const absSegs = splitPath(abs);
  if (!absSegs.some((seg) => seg.includes('*'))) {
    if (absSegs.length !== 0 && !hasPath(root, abs)) return [];
    const parentSegs = absSegs.slice(0, -1);
    const rawKey = absSegs[absSegs.length - 1];
    return [{
      data: absSegs.length === 0 ? root : getBySegments(root, absSegs),
      path: absSegs,
      depth: absSegs.length,
      parent: parentSegs.length ? getBySegments(root, parentSegs) : undefined,
      parentKey: rawKey !== undefined && isNumericSegment(rawKey) ? Number(rawKey) : rawKey,
    }];
  }
  const targets: SearchResultNode[] = [];
  for (const n of dfsIterator(root, { ...traversal, buildMeta: true, returnPaths: true })) {
    const p = n.path;
    if (p && p.length === absSegs.length && p.every((v, i) => absSegs[i] === '*' || v === absSegs[i])) targets.push(n);
  }
  return targets;
}

// Select potential target nodes based on a criterion evaluated against each traversed node
export function selectTargets(
  root: unknown,
  options: SearchOptions,
  targetKey: string,
  targetOperator: ComparisonOperator,
  targetValue: unknown,
  buildMeta = true
): SearchResultNode[] {
  const segs = splitPath(targetKey);
  const opFn = getOperatorFn(targetOperator);
  // Compile the target criterion when it is a simple single-segment, non-deep test
  // so target selection pays the same per-node cost as the flat-array fast path.
  const targetCriterion = segs.length === 1 ? compileCriterion(targetKey, targetOperator, targetValue) : null;
  const targetPred = targetCriterion ? compileCriteriaPredicate([targetCriterion]) : null;
  const traversal = resolveTraversal(options);
  if (targetKey.startsWith('$')) return selectAbsolute(root, traversal, targetKey);

  const targets: SearchResultNode[] = [];
  scanJsonMatches(
    root,
    { ...traversal, buildMeta, returnPaths: false },
    targetPred ?? ((node) => opFn(getBySegments(node, segs), targetValue)),
    (n) => { targets.push(n); }
  );
  return targets;
}
