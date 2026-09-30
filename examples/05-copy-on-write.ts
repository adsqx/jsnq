// Mutation modes: in place, immutable (deep clone), and copy-on-write for host commits.
import { JsnqPipeline, tryFastPipelineMutation } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';
import { expectEqual, expectTrue } from './_check';

type Row = { id: number; active: boolean; score: number; meta: { tags: string[] } };
const makeRows = (): Row[] => [
  { id: 1, active: true, score: 10, meta: { tags: ['a'] } },
  { id: 2, active: false, score: 20, meta: { tags: ['b'] } },
  { id: 3, active: true, score: 30, meta: { tags: ['c'] } },
];
const scores = (rows: Row[]) => rows.map((r) => r.score);

// 1. Default: the pipeline edits the array you gave it.
const inPlace = makeRows();
new JsnqPipeline(inPlace).pipe(where('active', '===', true), update('score', 0)).all();
expectEqual(scores(inPlace), [0, 20, 0], 'default mode mutates the input');

// 2. immutable: true deep-clones the input once. The original is never touched,
//    but nothing is shared with it either.
const original = makeRows();
const immutable = new JsnqPipeline(original, { immutable: true })
  .pipe(where('active', '===', true), update('score', 0));
immutable.all();
const next = immutable.data as Row[];
expectEqual(scores(original), [10, 20, 30], 'immutable: the original is untouched');
expectEqual(scores(next), [0, 20, 0], 'immutable: the result carries the update');
expectTrue(next[1] !== original[1] && next[1].meta !== original[1].meta, 'immutable: even unmatched rows are fresh copies');

// 3. Copy-on-write (used by the store bridges): tryFastPipelineMutation returns a new outer
//    array and new objects for matched rows only. Everything else keeps its identity.
const source = makeRows();
const result = tryFastPipelineMutation(source, [where('active', '===', true), update('score', 0)]);
if (!result) throw new Error('flat array + where + update should take the copy-on-write path');
const cow = result.value;
expectEqual(scores(source), [10, 20, 30], 'copy-on-write: the original is untouched');
expectEqual(scores(cow), [0, 20, 0], 'copy-on-write: the result carries the update');
expectTrue(cow !== source, 'copy-on-write: new outer array');
expectTrue(cow[0] !== source[0], 'copy-on-write: a matched row is a new object');
expectTrue(cow[1] === source[1], 'copy-on-write: an unmatched row is the very same object');
expectTrue(cow[0].meta === source[0].meta, 'copy-on-write: untouched nested values are shared too');
expectEqual([result.matched, result.mutations], [2, 2], 'copy-on-write: matched rows and applied actions');

// No match: the input itself comes back, so `===` change detection sees "no change".
const untouched = tryFastPipelineMutation(source, [where('id', '===', 99), update('score', 0)]);
expectTrue(untouched?.value === source, 'copy-on-write: no match keeps the original identity');

// The fast path only covers guarded shapes. It returns undefined for everything else
// (here: a non-array root), and the caller falls back to a normal pipeline.
const tree = { row: makeRows()[0] };
expectEqual(tryFastPipelineMutation(tree, [where('active', '===', true), update('score', 0)]), undefined, 'unsupported shape returns undefined');
