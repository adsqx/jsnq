// Structural operations: move, copy, insert and delete elements inside one tree.
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import moveTo from '@adsq/jsnq/operators/moveTo';
import copyTo from '@adsq/jsnq/operators/copyTo';
import copyToAll from '@adsq/jsnq/operators/copyToAll';
import moveToMatches from '@adsq/jsnq/operators/moveToMatches';
import insert from '@adsq/jsnq/operators/insert';
import insertTo from '@adsq/jsnq/operators/insertTo';
import deleteElement from '@adsq/jsnq/operators/deleteElement';
import { expectEqual, expectThrows, show } from './_check';

type Card = { id: number; title: string };
type Board = { columns: Array<{ name: string; cards: Card[] }>; archive: Record<string, Card> };

const makeBoard = (): Board => ({
  columns: [
    { name: 'todo', cards: [{ id: 1, title: 'Write docs' }, { id: 2, title: 'Ship it' }] },
    { name: 'doing', cards: [] },
    { name: 'done', cards: [] },
  ],
  archive: {},
});
// One line per column, so every step is easy to read.
const view = (b: Board) => b.columns.map((c) => `${c.name}:[${c.cards.map((card) => card.id)}]`).join(' ');

// moveTo(path): matched nodes leave their old parent and are appended to the array at `path`.
const board = makeBoard();
new JsnqPipeline(board).pipe(where('id', '===', 1), moveTo('columns.1.cards')).all();
expectEqual(view(board), 'todo:[2] doing:[1] done:[]', 'moveTo appends to the target array');

// The same with an explicit position: inside an array, `key` is the index.
new JsnqPipeline(board).pipe(where('id', '===', 2), moveTo('columns.1.cards', 'inside', 0)).all();
expectEqual(view(board), 'todo:[] doing:[2,1] done:[]', "moveTo(..., 'inside', 0) inserts at index 0");

// Select targets by an absolute path. `$` is the root; `*` matches any single segment.
// copyToAll copies the source into EVERY target, copyToMatches/moveToMatches into the first.
new JsnqPipeline(board).pipe(where('title', '===', 'Ship it'), copyToAll('$.columns.*.cards', '===', true)).all();
expectEqual(view(board), 'todo:[2] doing:[2,1,2] done:[2]', "copyToAll('$.columns.*.cards', ...) fans out");

new JsnqPipeline(board).pipe(where('id', '===', 1), moveToMatches('$.columns.2.cards', '===', true)).all();
expectEqual(view(board), 'todo:[2] doing:[2,2] done:[2,1]', "moveToMatches('$.columns.2.cards', ...) moves to that one target");

// Relative insert next to each match, then remove elements again.
new JsnqPipeline(board).pipe(where('id', '===', 1), insert({ id: 9, title: 'Retro' }, 'after')).all();
expectEqual(view(board), 'todo:[2] doing:[2,2] done:[2,1,9]', "insert(..., 'after') puts the new card after the match");

new JsnqPipeline(board).pipe(where('id', '===', 2), deleteElement()).all();
expectEqual(view(board), 'todo:[] doing:[] done:[1,9]', 'deleteElement() removes every match from its parent');

// insertTo needs no match at all: it writes straight to a path.
new JsnqPipeline(board).pipe(insertTo('columns.0.cards', { id: 10, title: 'Plan' }, 'inside', 0)).all();
expectEqual(view(board), 'todo:[10] doing:[] done:[1,9]', 'insertTo() inserts at a path');

// copyTo(path): the source stays, a deep clone lands at the target.
// Object targets need an explicit string key, because there is no position to append to.
new JsnqPipeline(board).pipe(where('id', '===', 1), copyTo('archive', 'inside', 'card-1')).all();
expectEqual(board.archive['card-1'], { id: 1, title: 'Write docs' }, "copyTo('archive', 'inside', 'card-1')");
expectEqual(view(board), 'todo:[10] doing:[] done:[1,9]', 'the source card is still in place');
expectEqual(board.archive['card-1'] !== board.columns[2].cards[0], true, 'the copy is a separate object');

// Invalid structure fails before anything is removed: a node cannot move into itself.
const tree = { node: { kind: 'box', children: [{ kind: 'leaf' }] } };
expectThrows(
  () => new JsnqPipeline(tree).pipe(where('kind', '===', 'box'), moveTo('node.children')).all(),
  /source or one of its descendants/,
  'moving a node into its own subtree throws',
);
expectEqual(tree.node.children.length, 1, 'the tree is unchanged after the failed move');
show('final board', view(board));
