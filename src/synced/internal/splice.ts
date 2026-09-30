/** Array insertion helpers shared by ops (and available to the pipeline fast paths). */

/** Negative indices clamp to 0 (native `splice` would count from the end); overflow clamps natively. */
export const clampIndex = (index: number): number => (index < 0 ? 0 : index);

/**
 * Insert one `item` at `index` clamped into `[0, arr.length]` (no deletion).
 * Single-item on purpose: a rest-parameter form measured ~2x slower on the insert hot path.
 */
export function spliceClamped<T>(arr: T[], index: number, item: T): void {
  arr.splice(clampIndex(index), 0, item);
}
