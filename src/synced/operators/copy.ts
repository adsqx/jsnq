import { relocate } from '../internal/relocate';

export type { RelocateTarget, RelocateOptions } from '../internal/relocate';

/**
 * Copy each matched node (the original stays). One entry point for the whole copy family:
 * - `copy('archive')` — to a path (same as `copyTo`)
 * - `copy({ where: ['type', '===', 'basket'] })` — into the first node selected by the criterion
 *   (`copyToMatches`); `into: 'all'` copies into every selected node (`copyToAll`)
 * Options: `mode` ('inside' | 'before' | 'after', default 'inside') and `key` for object targets.
 */
const copy = relocate('copy');

export default copy;
