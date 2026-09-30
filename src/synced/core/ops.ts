/** Public entry for insert/move/copy helpers; implementations live in ../internal/*. */
export { assignWithPolicy, getAssignmentEffect } from '../internal/assign-policy';
export { canRemoveFromOriginal, removeFromOriginal, wouldCreateMoveCycle, wouldCreateMoveCycleAtPath, orderMatchesForMove } from '../internal/move-ops';
export { assertCanInsertIntoTargetPath, canInsertIntoResolvedTarget, insertRelative, canInsertRelative, insertIntoTargetPath } from '../internal/insert-ops';
export { selectTargets, fanoutMatchesToTargets } from '../internal/fanout';
