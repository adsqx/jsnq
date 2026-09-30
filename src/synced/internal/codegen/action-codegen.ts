/** Per-action source templates for the compiled flat-array mutation loop. */
import type { ActionMap, ActionType } from '../types/actions';
import type { PipelineStats } from '../types/stats';

type NumericStat = { [K in keyof PipelineStats]: PipelineStats[K] extends number ? K : never }[keyof PipelineStats];

export interface ActionCodegen {
  /** Counter bumped once per matched item. */
  stat: NumericStat;
  /** Tail of the strictPathsWarn message: `<type>: path '<key>' did not exist<warnMsg>`. */
  warnMsg: string;
  /** Statement applying the action to `target[key]` (`val` = source ref of the action's value/patch). */
  emit: (key: string, val: string, i: number) => string;
}

/** Action types the compiled loop can handle (all others use the interpreter). */
export type CodegenType = Extract<ActionType, 'update' | 'replace' | 'delete_key' | 'merge_update'>;
export type CodegenAction = ActionMap[CodegenType];

const assign = (key: string, val: string): string => `if (!dryRun) target[${key}] = ${val};`;

export const ACTION_CODEGEN: { readonly [K in CodegenType]: ActionCodegen } = {
  update: { stat: 'updates', warnMsg: '; created implicitly', emit: assign },
  replace: { stat: 'replaces', warnMsg: '; created implicitly', emit: assign },
  delete_key: { stat: 'deletedKeys', warnMsg: '', emit: (key) => `if (!dryRun) delete target[${key}];` },
  merge_update: {
    stat: 'mergeUpdates',
    warnMsg: '; created implicitly',
    emit: (key, patch, i) =>
      `if (!dryRun) { var current${i} = target[${key}]; target[${key}] = (current${i} !== null && typeof current${i} === 'object' && ${patch} !== null && typeof ${patch} === 'object') ? Object.assign({}, current${i}, ${patch}) : ${patch}; }`,
  },
};

export function isCodegenAction(a: { type: ActionType }): a is CodegenAction {
  return Object.hasOwn(ACTION_CODEGEN, a.type);
}

/** The runtime value bound into the generated loop's `vals` array for this action. */
export function actionValue(a: CodegenAction): unknown {
  return a.type === 'merge_update' ? a.patch : a.type === 'delete_key' ? undefined : a.value;
}
