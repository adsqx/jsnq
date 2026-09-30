import type { JsonContainer } from './types';

/**
 * Per-call clone state. The cycle / shared-reference registry is allocated lazily, on the
 * first container that has a container child: values without nested containers (the common
 * flat-row case) never pay for a WeakMap. Every container cloned after that point is
 * registered before its children are visited, so cycles and shared refs resolve exactly as
 * if the registry had existed from the start (only the root can predate it, and it is
 * registered when the registry is created).
 */
interface CloneState {
  seen: WeakMap<object, unknown> | null;
}

/** Functions and symbols have no plain-data clone; defer to structuredClone (which rejects them). */
function cloneOpaque(value: unknown): unknown {
  return typeof structuredClone === 'function' ? structuredClone(value) : value;
}

/** Clone of a container child of `parent` (whose clone `parentClone` is registered on first use). */
function cloneChild(value: object, parent: object, parentClone: unknown, state: CloneState): unknown {
  let seen = state.seen;
  if (seen === null) {
    seen = state.seen = new WeakMap();
    seen.set(parent, parentClone);
  }
  const cached = seen.get(value);
  return cached !== undefined ? cached : cloneContainer(value, state);
}

function cloneArray(source: unknown[], state: CloneState): unknown[] {
  const length = source.length;
  // Presized (holey-kind) like the original: measured faster than push-built packed arrays,
  // and holes stay holes because absent indices are simply never assigned.
  const clone: unknown[] = new Array(length);
  state.seen?.set(source, clone);
  for (let i = 0; i < length; i++) {
    const item = source[i];
    // A hole reads as undefined, so `in` is only consulted for undefined items.
    if (item === undefined && !(i in source)) continue;
    clone[i] = cloneItem(item, source, clone, state);
  }
  return clone;
}

function cloneItem(item: unknown, parent: object, parentClone: unknown, state: CloneState): unknown {
  if (typeof item === 'object' && item !== null) return cloneChild(item, parent, parentClone, state);
  return typeof item === 'function' || typeof item === 'symbol' ? cloneOpaque(item) : item;
}

function cloneContainer(value: object, state: CloneState): unknown {
  if (Array.isArray(value)) return cloneArray(value, state);

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Non-plain host objects (Date, Map, class instances, ...) keep the structuredClone behavior.
    const clone = typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    if (typeof structuredClone === 'function') state.seen?.set(value, clone);
    return clone;
  }

  const clone: JsonContainer = prototype === null ? Object.create(null) : {};
  state.seen?.set(value, clone);
  const source = value as JsonContainer;
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const child = cloneItem(source[key], value, clone, state);
    if (key === '__proto__') {
      Object.defineProperty(clone, key, { value: child, enumerable: true, configurable: true, writable: true });
    } else {
      clone[key] = child;
    }
  }
  return clone;
}

/**
 * Clone the JSON-like state shape without paying structuredClone's serializer
 * overhead for ordinary arrays and records. Non-plain host objects retain the
 * previous structuredClone behavior; the registry also preserves shared refs
 * and cycles for plain data supplied through untyped JavaScript callers.
 */
export function cloneJsonData<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return cloneContainer(value, { seen: null }) as T;
}
