import { isObjectLike } from '../guards';
import { ensureChild, getJsonBySegments, setAt, writeJsonPath } from './json-ops';
import { createExactSetResult } from './mutation-result';
import { createJsonPathPlan } from './plan-cache';
import type { JsonContainer, JsonMutationResult, JsonPathPlan } from './types';

/**
 * Remembers the container reached by the last write so consecutive writes under the
 * same parent skip the walk from the root.
 */
export class JsonDataCursor {
  private cursorNode: Record<string, unknown> | null = null;
  private cursorPathSegments: string[] | null = null;

  prefetch(path: string, node: Record<string, unknown> | null): void {
    const plan = createJsonPathPlan(path);
    this.cursorNode = node ?? null;
    this.cursorPathSegments = plan.segments.length > 0 ? [...plan.segments] : null;
  }

  writeWithPlan(root: Record<string, unknown>, plan: JsonPathPlan, value: unknown): JsonMutationResult {
    const key = plan.key;
    if (key == null) {
      return createExactSetResult(plan, root, value, true, isObjectLike(root) || isObjectLike(value));
    }

    const { parentSegments, nextIsIndex } = plan;
    let current: JsonContainer = root;
    let startIndex = 0;
    const cached = this.cursorPathSegments;
    if (this.cursorNode && cached && cached.length <= parentSegments.length) {
      let isPrefix = true;
      // Repeat write under the same parent: the cursor holds the plan's own array.
      if (cached !== parentSegments) {
        for (let i = 0; isPrefix && i < cached.length; i++) isPrefix = cached[i] === parentSegments[i];
      }
      if (isPrefix) {
        current = this.cursorNode;
        startIndex = cached.length;
      }
    }

    try {
      for (let i = startIndex; i < parentSegments.length; i++) {
        current = ensureChild(current, parentSegments[i]!, !!nextIsIndex[i]);
      }
      const result = setAt(current, plan, key, value);
      this.cursorNode = current;
      this.cursorPathSegments = parentSegments;
      return result;
    } catch {
      const result = writeJsonPath(root, plan, value);
      const parent = getJsonBySegments(root, parentSegments);
      this.cursorNode = isObjectLike(parent) ? parent : null;
      this.cursorPathSegments = parentSegments.slice();
      return result;
    }
  }

  invalidateForDeletion(path: string): void {
    if (!this.cursorPathSegments) return;
    const currentPath = this.cursorPathSegments.join('.');
    if (currentPath === path || currentPath.startsWith(`${path}.`) || path.startsWith(`${currentPath}.`)) {
      this.clear();
    }
  }

  clear(): void {
    this.cursorNode = null;
    this.cursorPathSegments = null;
  }

  get active(): boolean {
    return this.cursorNode !== null;
  }
}
