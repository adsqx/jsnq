/**
 * Public entry for insert/move/copy helpers. Implementations live in ../internal/*;
 * this module keeps every historical export name resolving.
 */
export { assignWithPolicy, getAssignmentEffect } from '../internal/assign-policy';
export { canRemoveFromOriginal, removeFromOriginal, wouldCreateMoveCycle, wouldCreateMoveCycleAtPath, orderMatchesForMove } from '../internal/move-ops';
export { assertCanInsertIntoTargetPath, canInsertIntoResolvedTarget, insertRelative, canInsertRelative, insertIntoTargetPath } from '../internal/insert-ops';
export { selectTargets } from '../internal/select-targets';
export { fanoutMatchesToTargets } from '../internal/fanout';
