/** Move/copy fan-out: target selection (absolute `$` paths or a criterion over traversed nodes), then plan -> remove -> insert. */
import type { InsertPosition } from './types/actions';
import type { ComparisonOperator, SearchOptions, SearchResultNode } from './types/model';
import { isNumericSegment, isObject } from './guards';
import { resolveTraversal, type Traversal, type WarnSink } from './run-options';
import { arrayAt, insertConflictError, resolveOverwriteEffect, warnOverwrite } from './assign-policy';
import { canInsertRelative, insertRelative, objectContainerFor } from './insert-ops';
import { canRemoveFromOriginal, orderMatchesForMove, removeFromOriginal, wouldCreateMoveCycle } from './move-ops';
import { cloneJson, getBySegments, hasPath, splitPath } from './tree-utils';
import { dfsIterator, scanJsonMatches } from './traverse';
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

type Key = string | number | undefined;
interface PlannedTarget { target: SearchResultNode; effectiveKey: Key }
interface SourcePlan { src: SearchResultNode; targets: PlannedTarget[] }

function defaultIdKey(data: unknown): string | undefined {
  const id = isObject(data) ? data.id : undefined;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

// Choose key per context: explicit > (inside object: source key or id) > (before/after on object: id or source key)
function chooseEffectiveKey(src: SearchResultNode, target: SearchResultNode, pos: InsertPosition, key: Key): Key {
  if (key !== undefined) return key;
  if (!objectContainerFor(target, pos)) return undefined;
  const srcKey = typeof src.parentKey === 'string' ? src.parentKey : undefined;
  const idKey = defaultIdKey(src.data);
  return pos === 'inside' ? srcKey ?? idKey : idKey ?? srcKey;
}

/** The object slot a keyed insert would write (undefined when it pushes into an array or has no object container). */
function plannedObjectSlot(target: SearchResultNode, pos: InsertPosition, key: Key): { owner: Record<string, unknown>; key: string } | undefined {
  const owner = typeof key === 'string' ? objectContainerFor(target, pos) : undefined;
  if (!owner || typeof key !== 'string') return undefined;
  return pos === 'inside' && arrayAt(owner, key) ? undefined : { owner, key };
}

/** Claim `slot` for this fan-out; false when the policy says a second write to it must be skipped. */
function reserveSlot(
  reserved: WeakMap<object, Set<string>>,
  slot: { owner: Record<string, unknown>; key: string },
  options: SearchOptions | undefined,
  stats: WarnSink | undefined
): boolean {
  let keys = reserved.get(slot.owner);
  if (!keys) reserved.set(slot.owner, keys = new Set<string>());
  if (keys.has(slot.key) && resolveOverwriteEffect(true, slot.key, options, insertConflictError) === 'skip') {
    warnOverwrite(options, stats, slot.key);
    return false;
  }
  keys.add(slot.key);
  return true;
}

// Fan-out helper for move/copy matches into targets
export function fanoutMatchesToTargets(
  kind: 'move' | 'copy',
  matches: SearchResultNode[],
  targets: SearchResultNode[],
  mode: InsertPosition = 'inside',
  key?: string | number,
  options?: SearchOptions,
  stats?: { warnings: string[] },
  dryRun = false
): number {
  const pos: InsertPosition = mode ?? 'inside';
  const isMove = kind === 'move';
  const plans: SourcePlan[] = [];
  const reservedSlots = new WeakMap<object, Set<string>>();
  for (const src of matches) {
    if (isMove && !canRemoveFromOriginal(src)) {
      stats?.warnings.push('move_matches: source is not attached to a removable parent; source left in place');
      continue;
    }
    const planned: PlannedTarget[] = [];
    for (const target of targets) {
      if (isMove && wouldCreateMoveCycle(src.data, target, pos)) continue;
      const effectiveKey = chooseEffectiveKey(src, target, pos, key);
      // Match fan-out into an object follows the explicit-key/id contract. The
      // keyless object merge remains available to the standalone insert operator.
      if (pos === 'inside' && effectiveKey === undefined && objectContainerFor(target, pos)) continue;
      if (!canInsertRelative(target, src.data, pos, effectiveKey, options)) continue;
      const slot = plannedObjectSlot(target, pos, effectiveKey);
      if (slot && !reserveSlot(reservedSlots, slot, options, stats)) continue;
      planned.push({ target, effectiveKey });
    }
    if (isMove && planned.length === 0) {
      stats?.warnings.push('move_matches: no insertable targets; source left in place');
      continue;
    }
    plans.push({ src, targets: planned });
  }

  if (isMove && !dryRun) {
    for (const src of orderMatchesForMove(plans.map((plan) => plan.src))) {
      if (!removeFromOriginal(src)) throw new Error('move_matches: source changed before it could be removed');
    }
  }

  // Insert in original match order after all removals. This preserves source
  // ordering while retaining descending-index removal safety.
  let applied = 0;
  for (const plan of plans) {
    for (let i = 0; i < plan.targets.length; i++) {
      if (dryRun) {
        applied++;
        continue;
      }
      const { target, effectiveKey } = plan.targets[i];
      // Every copy target owns its clone. A multi-target move keeps the original
      // in the first target and clones subsequent targets to avoid shared state.
      const element = !isMove || i > 0 ? cloneJson(plan.src.data) : plan.src.data;
      if (insertRelative(target, element, pos, effectiveKey, options, stats)) applied++;
    }
  }
  return applied;
}
