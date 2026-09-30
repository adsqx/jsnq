// The path engine on its own: read, write, delete and inspect paths without a pipeline.
// Note: unlike immutable pipelines these functions mutate the object you pass in.
import {
  createJsonPathPlan,
  deleteJsonPath,
  getJsonAffectedPaths,
  hasJsonPath,
  readJsonPath,
  writeJsonPath,
} from '@adsq/jsnq/data-engine';
import { expectEqual, expectThrows, show } from './_check';

const state: Record<string, unknown> = {};

// Writes create every missing container. A numeric next segment creates an array.
const write = writeJsonPath(state, 'workspace.pages.0.title', 'Home');
expectEqual(state, { workspace: { pages: [{ title: 'Home' }] } }, 'write created objects and an array');

// The mutation result says exactly what changed, e.g. to wake precise subscribers.
show('write result', {
  kind: write.kind,
  existed: write.existed,
  changed: write.changed,
  inserted: write.inserted,
  parents: write.parents,
});

// Overwriting reports the previous value.
const rename = writeJsonPath(state, 'workspace.pages.0.title', 'Start');
expectEqual([rename.existed, rename.previous, rename.next], [true, 'Home', 'Start'], 'overwrite reports previous and next');

// Dot, index and bracket forms are equivalent; quotes protect keys that contain dots.
writeJsonPath(state, 'workspace.settings["display.name"]', 'Ada');
expectEqual(readJsonPath(state, 'workspace.pages[0].title'), 'Start', 'bracket index read');
expectEqual(readJsonPath(state, 'workspace.settings["display.name"]'), 'Ada', 'quoted key with a dot');
expectEqual(readJsonPath(state, 'workspace.pages.5.title'), undefined, 'a missing path reads as undefined');
expectEqual(hasJsonPath(state, 'workspace.pages.1'), false, 'hasJsonPath checks own keys and array bounds');

// A compiled plan skips re-parsing when you use the same path repeatedly.
const plan = createJsonPathPlan('workspace.pages.0.title');
expectEqual(readJsonPath(state, plan), 'Start', 'read through a reusable plan');
expectEqual(plan.segments, ['workspace', 'pages', '0', 'title'], 'plan.segments');
expectEqual(getJsonAffectedPaths(plan, 'branch').length, 4, "'branch' mode lists the path and each ancestor");

// Deleting an array index splices, deleting an object key removes it.
const removal = deleteJsonPath(state, 'workspace.pages.0.title');
expectEqual([removal.kind, removal.previous, removal.deleted], ['delete', 'Start', ['workspace.pages.0.title']], 'delete result');
expectEqual(hasJsonPath(state, 'workspace.pages.0.title'), false, 'the key is gone');

// Prototype-pollution guard: __proto__, prototype and constructor segments are rejected.
expectThrows(() => writeJsonPath(state, '__proto__.polluted', true), /Unsafe path segment/, '__proto__ path is refused');
expectThrows(() => readJsonPath(state, 'a.constructor.prototype'), /Unsafe path segment/, 'constructor path is refused');
expectEqual(({} as { polluted?: boolean }).polluted, undefined, 'Object.prototype was not touched');
