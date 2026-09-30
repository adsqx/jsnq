import type { ComparisonOperator } from './types';
import { BUILTIN_OPS } from '../internal/codegen/builtin-ops';

/** Function signature for registered comparison operators. */
type OperatorFn = (a: unknown, b: unknown) => boolean;

// Operator registry local to jsnq core, seeded from the shared built-in table
// (prototype-less so operator names such as 'constructor' are never inherited).
const Operators: Record<string, OperatorFn> = Object.create(null);
for (const name of Object.keys(BUILTIN_OPS)) Operators[name] = BUILTIN_OPS[name].fn;

export function registerOperator(name: string, fn: OperatorFn): void {
  Operators[name] = fn;
}

const fallbackFn: OperatorFn = () => false;
export const getOperatorFn = (op: ComparisonOperator): OperatorFn => {
  return Operators[op] ?? fallbackFn;
};

export function isOperatorKnown(op: string): boolean {
  return typeof Operators[op] === 'function';
}
