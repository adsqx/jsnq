// Compile-time contract for the ergonomic entry points (typechecked by `bun run test:types`).
import { JsnqPipeline, where, update, move, copy } from '../src/synced';

type Data = { users: Array<{ id: number; name: string; profile: { age: number } }>; archive: string[] };
const data: Data = { users: [{ id: 1, name: 'Ann', profile: { age: 31 } }], archive: [] };

// where(predicate) / where(key, predicate): the key types the predicate argument
new JsnqPipeline<Data>(data).pipe(where((node) => node !== null), update('users.0.name', 'Ada'));
new JsnqPipeline<Data>(data).pipe(where('users.0.profile.age', (age) => age >= 18));
// @ts-expect-error — a predicate must return a boolean
where((node: unknown) => 'yes');
// @ts-expect-error — the age is a number, so a string method does not exist on it
new JsnqPipeline<Data>(data).pipe(where('users.0.profile.age', (age) => age.startsWith('1')));

// move / copy: a path or a { where } target, plus options
move('archive');
move('archive', { mode: 'before' });
move({ where: ['type', '===', 'basket'] });
move({ where: ['type', '===', 'basket'], into: 'all' }, { key: 'item' });
move({ where: ['kind', '===', 'slot'] }, { overwrite: 'current' });
copy('archive');
copy({ where: ['type', '===', 'basket'], into: 'all' });
// @ts-expect-error — into accepts only 'first' | 'all'
move({ where: ['type', '===', 'basket'], into: 'each' });
// @ts-expect-error — mode accepts only 'inside' | 'before' | 'after'
copy('archive', { mode: 'above' });

// Relative keys (checked on every node) type the predicate through an annotation
type User = { id: number; active: boolean; score: number };
const users: User[] = [{ id: 1, active: true, score: 10 }];
new JsnqPipeline(users).pipe(where('score', (score: number) => score > 5));
new JsnqPipeline(users).pipe(where((u: User) => u.active && u.score > 5));
