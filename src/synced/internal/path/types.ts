/** Public data-engine types (re-exported by core/data-engine). Type-level only. */

export type JsonDataPathMode = 'exact' | 'branch';

export interface JsonPathPlan {
  path: string;
  segments: string[];
  parentSegments: string[];
  key: string | null;
  nextIsIndex: boolean[];
}

export type JsonMutationKind = 'set' | 'delete' | 'noop';

export interface JsonMutationResult {
  path: string;
  kind: JsonMutationKind;
  previous: unknown;
  next: unknown;
  existed: boolean;
  changed: string[];
  inserted: string[];
  deleted: string[];
  parents: string[];
  descendants: string[];
  branchReplaced: boolean;
  affectedPaths: string[];
}

export interface JsonMutationResultInit {
  path: string | JsonPathPlan;
  kind: JsonMutationKind;
  previous?: unknown;
  next?: unknown;
  existed?: boolean;
  changed?: readonly string[];
  inserted?: readonly string[];
  deleted?: readonly string[];
  parents?: readonly string[];
  descendants?: readonly string[];
  branchReplaced?: boolean;
  affectedPaths?: readonly string[];
}

export interface JsonResolvedParent {
  parent: any;
  key: string | null;
  segments: string[];
}

export interface JsonPlanCacheStats {
  size: number;
  limit: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  hitRate: number;
}

/** Internal: an object/array/function node the engine may read or write into. */
export type JsonContainer = Record<string, unknown>;
