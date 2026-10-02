import { relocate } from '../internal/relocate';

export type { RelocateTarget, RelocateOptions } from '../internal/relocate';

/**
 * Move each matched node. One entry point for the whole move family:
 * - `move('done')` — to a path (same as `moveTo`)
 * - `move({ where: ['type', '===', 'basket'] })` — into the first node selected by the criterion
 *   (`moveToMatches`); `into: 'all'` moves into every selected node (`moveToAll`)
 * - `move({ where: [...] }, { overwrite: 'current' })` — into `target.current`, replacing it
 *   (`moveToMatchesOverwrite`)
 * Options: `mode` ('inside' | 'before' | 'after', default 'inside') and `key` for object targets.
 */
const move = relocate('move');

export default move;
