import { assertSafeSegments, isNumericSegment } from '../guards';
import type { JsonPathPlan } from './types';

/** Reads a `[...]` group starting just after the `[`; pushes its segment and returns the next index. */
function readBracket(path: string, start: number, out: string[]): number {
  const n = path.length;
  let i = start;
  const quote = path[i];
  if (quote === '"' || quote === "'") {
    i++;
    let quoted = '';
    while (i < n) {
      const ch = path[i]!;
      if (ch === '\\' && i + 1 < n) {
        quoted += path[i + 1];
        i += 2;
      } else if (ch === quote) {
        i++;
        break;
      } else {
        quoted += ch;
        i++;
      }
    }
    if (path[i] === ']') i++;
    out.push(quoted); // a quoted segment may be empty
    return i;
  }
  let end = path.indexOf(']', i);
  if (end < 0) end = n;
  if (end > i) out.push(path.slice(i, end));
  return end < n ? end + 1 : end;
}

/** Full scanner: handles `\` escapes, `[idx]` and `["quoted"]` groups. Empty dotted segments are dropped. */
function scanPath(path: string): string[] {
  const out: string[] = [];
  const n = path.length;
  let token = '';
  let i = 0;
  while (i < n) {
    const ch = path[i]!;
    if (ch === '\\') {
      if (i + 1 < n) token += path[i + 1];
      i += 2;
    } else if (ch === '.' || ch === '[') {
      if (token) {
        out.push(token);
        token = '';
      }
      i++;
      if (ch === '[') {
        if (i >= n) break;
        i = readBracket(path, i, out);
      }
    } else {
      token += ch;
      i++;
    }
  }
  if (token) out.push(token);
  return out;
}

export function splitJsonPath(path: string): string[] {
  // Non-string input (untyped callers) has always produced an empty split rather than a throw.
  if (!path || typeof path !== 'string') return [];
  let out: string[];
  if (path.indexOf('\\') < 0 && path.indexOf('[') < 0) {
    // Plain dotted path: no escapes or brackets, so a native split is exact.
    out = path.split('.');
    if (out.indexOf('') >= 0) out = out.filter(Boolean);
  } else {
    out = scanPath(path);
  }
  assertSafeSegments(out, path);
  return out;
}

/** The single place a plan literal is built (fixed key order keeps plans monomorphic). */
export function buildPlan(path: string, segments: string[]): JsonPathPlan {
  const last = segments.length - 1;
  const nextIsIndex: boolean[] = [];
  for (let i = 1; i <= last; i++) nextIsIndex.push(isNumericSegment(segments[i]));
  return {
    path,
    segments,
    parentSegments: segments.slice(0, -1),
    key: last >= 0 ? segments[last]! : null,
    nextIsIndex,
  };
}

/** Uncached plan from raw segments (used by fast paths that already hold split segments). */
export function createJsonPathPlanFromSegments(segments: readonly string[]): JsonPathPlan {
  const safeSegments = Array.from(segments, String);
  const path = safeSegments.join('.');
  assertSafeSegments(safeSegments, path);
  return buildPlan(path, safeSegments);
}
