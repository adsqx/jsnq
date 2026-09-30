// TypeScript path typing: Path<T>, PathValue<T, P>, and typed updater callbacks.
import { JsnqPipeline } from '@adsq/jsnq';
import type { Path, PathValue } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';
import { expectEqual } from './_check';

// Use `type`, not `interface`: JsnqPipeline<TData> requires a JSON-like shape, and interfaces
// have no implicit index signature so they do not satisfy that constraint.
type Data = {
  users: Array<{ id: number; name: string; stats: { logins: number }; tags: string[] }>;
  settings: { theme: 'light' | 'dark' };
};

// Path<Data> is the union of valid dotted paths. Array indexes are written `0` or `[0]`
// after a dot: `users.0.name` and `users.[0].name` are both in the union.
const ok1: Path<Data> = 'users.0.stats.logins';
const ok2: Path<Data> = 'settings.theme';
// @ts-expect-error 'stats.logins' is not a top-level key of Data
const bad: Path<Data> = 'stats.logins';

// PathValue<T, P> resolves the type found at a path.
type Logins = PathValue<Data, 'users.0.stats.logins'>; // number
type Theme = PathValue<Data, 'settings.theme'>; // 'light' | 'dark'
const logins: Logins = 3;
const theme: Theme = 'dark';

// Handy pattern: define path constants once and let the compiler check them.
const paths = {
  logins: 'users.0.stats.logins',
  theme: 'settings.theme',
} as const satisfies Record<string, Path<Data>>;

// With a typed pipeline, update() infers the callback types from the path:
// `current` is a number here, so `current + 1` needs no cast.
const data: Data = {
  users: [{ id: 1, name: 'Ann', stats: { logins: 2 }, tags: [] }],
  settings: { theme: 'light' },
};
const pipeline = new JsnqPipeline<Data>(data, { immutable: true }).pipe(
  where(paths.logins, '>=', 1),
  update(paths.logins, (current) => current + 1),
);
pipeline.all();
expectEqual((pipeline.data as Data).users[0].stats.logins, 3, 'typed updater incremented logins');
expectEqual(data.users[0].stats.logins, 2, 'the original is untouched (immutable: true)');
void [ok1, ok2, bad, logins, theme]; // the annotations above exist purely for the compiler
