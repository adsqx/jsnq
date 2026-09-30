/**
 * Single source of truth for the built-in comparison operators.
 *
 * Each entry carries the runtime implementation (`fn`, seeds the operator registry) and,
 * for operators the codegen fast paths can inline, `expr`: the boolean source expression
 * for value-var `a` and criterion-value ref `b`. `expr` must stay semantically identical
 * to `fn` (the fastpath-parity / vs-native suites guard that equivalence).
 */
export type OperatorImpl = (a: unknown, b: unknown) => boolean;
export interface BuiltinOp { fn: OperatorImpl; expr?: (a: string, b: string) => string }

const isPlainObject = (a: unknown): boolean => typeof a === 'object' && a !== null && !Array.isArray(a);

/** Source-inlinable binary operator (`a <op> b`) whose implementation is the same JS operator. */
const cmp = (fn: OperatorImpl, op: string): BuiltinOp => ({ fn, expr: (a, b) => `${a} ${op} ${b}` });

function regexTest(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string') return false;
  try {
    if (b instanceof RegExp) return b.test(a);
    const raw = String(b);
    // Support '/pattern/flags' or plain 'pattern'
    if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
      const last = raw.lastIndexOf('/');
      return new RegExp(raw.slice(1, last), raw.slice(last + 1)).test(a);
    }
    return new RegExp(raw).test(a);
  } catch {
    return false;
  }
}

export const BUILTIN_OPS: Readonly<Record<string, BuiltinOp>> = {
  '==': cmp((a, b) => a == b, '=='),
  '===': cmp((a, b) => a === b, '==='),
  '!=': cmp((a, b) => a != b, '!='),
  '!==': cmp((a, b) => a !== b, '!=='),
  '<': cmp((a, b) => (a as number) < (b as number), '<'),
  '<=': cmp((a, b) => (a as number) <= (b as number), '<='),
  '>': cmp((a, b) => (a as number) > (b as number), '>'),
  '>=': cmp((a, b) => (a as number) >= (b as number), '>='),
  includes: {
    fn: (a, b) => (typeof a === 'string' ? a.includes(String(b)) : Array.isArray(a) ? a.includes(b) : false),
    expr: (a, b) => `(typeof ${a}==='string' ? ${a}.includes(String(${b})) : Array.isArray(${a}) ? ${a}.includes(${b}) : false)`,
  },
  '!includes': {
    fn: (a, b) => (typeof a === 'string' ? !a.includes(String(b)) : Array.isArray(a) ? !a.includes(b) : true),
    expr: (a, b) => `(typeof ${a}==='string' ? !${a}.includes(String(${b})) : Array.isArray(${a}) ? !${a}.includes(${b}) : true)`,
  },
  startsWith: {
    fn: (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.startsWith(b) : false),
    expr: (a, b) => `(typeof ${a}==='string' && typeof ${b}==='string' ? ${a}.startsWith(${b}) : false)`,
  },
  endsWith: {
    fn: (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.endsWith(b) : false),
    expr: (a, b) => `(typeof ${a}==='string' && typeof ${b}==='string' ? ${a}.endsWith(${b}) : false)`,
  },
  regex: { fn: regexTest },
  // Type helpers
  isArray: {
    fn: (a, b) => (typeof b === 'boolean' ? Array.isArray(a) === b : Array.isArray(a)),
    expr: (a, b) => `(typeof ${b}==='boolean' ? Array.isArray(${a})===${b} : Array.isArray(${a}))`,
  },
  isObject: {
    fn: (a, b) => (typeof b === 'boolean' ? isPlainObject(a) === b : isPlainObject(a)),
    expr: (a, b) => `(typeof ${b}==='boolean' ? (typeof ${a}==='object'&&${a}!==null&&!Array.isArray(${a}))===${b} : (typeof ${a}==='object'&&${a}!==null&&!Array.isArray(${a})))`,
  },
};

/** Own-property lookup (operator names such as 'constructor' are never inherited). */
export function builtinOp(name: string): BuiltinOp | undefined {
  return Object.hasOwn(BUILTIN_OPS, name) ? BUILTIN_OPS[name] : undefined;
}
