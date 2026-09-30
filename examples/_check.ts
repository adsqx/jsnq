// Tiny assertion helper so the examples run with no dev dependencies (no @types/node).
// Every example prints what it demonstrates and throws if an expectation is wrong,
// which makes `npm run examples` a real regression check, not just a demo.

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// all() types each node's `data` as the pipeline's root type, so narrow it explicitly.
export const dataOf = <T>(nodes: ReadonlyArray<{ data: unknown }>): T[] => nodes.map((node) => node.data as T);

export function show(label: string, value: unknown): void {
  console.log(`${label}:`, JSON.stringify(value));
}

export function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (!same(actual, expected)) {
    throw new Error(
      `${label}\n  expected ${JSON.stringify(expected)}\n  received ${JSON.stringify(actual)}`,
    );
  }
  console.log(`ok - ${label}`);
}

export function expectTrue(condition: boolean, label: string): void {
  if (!condition) throw new Error(`${label} (expected true)`);
  console.log(`ok - ${label}`);
}

export function expectThrows(fn: () => unknown, pattern: RegExp, label: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) throw new Error(`${label}: unexpected error "${message}"`);
    console.log(`ok - ${label}`);
    return;
  }
  throw new Error(`${label}: expected an error, none was thrown`);
}
