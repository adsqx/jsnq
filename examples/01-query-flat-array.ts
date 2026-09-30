// Querying a flat array: where(), operators, all() / first() / count(), custom operators.
import { JsnqPipeline, registerOperator } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import { dataOf, expectEqual, show } from './_check';

type Order = { id: number; customer: string; total: number; status: string; tags: string[] };

const orders: Order[] = [
  { id: 1, customer: 'Ann', total: 120, status: 'paid', tags: ['gift'] },
  { id: 2, customer: 'Bob', total: 35, status: 'open', tags: [] },
  { id: 3, customer: 'Ada', total: 260, status: 'paid', tags: ['gift', 'express'] },
  { id: 4, customer: 'Cy', total: 80, status: 'refunded', tags: ['express'] },
];

// Several where() calls are AND-combined.
const bigPaid = new JsnqPipeline(orders).pipe(
  where('status', '===', 'paid'),
  where('total', '>=', 100),
);

// all() returns result nodes: { data, path, depth, ... }. first() returns the value or null.
show('bigPaid ids', dataOf<Order>(bigPaid.all()).map((order) => order.id));
expectEqual(bigPaid.count(), 2, 'count() of paid orders >= 100');
expectEqual(bigPaid.first<Order>()?.customer, 'Ann', 'first() returns the first match value');

// Built-in operators: comparison, includes (string or array), startsWith, endsWith, regex.
const express = new JsnqPipeline(orders).pipe(where('tags', 'includes', 'express'));
expectEqual(dataOf<Order>(express.all()).map((o) => o.id), [3, 4], "tags includes 'express'");

const aNames = new JsnqPipeline(orders).pipe(where('customer', 'regex', '/^a/i'));
expectEqual(dataOf<Order>(aNames.all()).map((o) => o.customer), ['Ann', 'Ada'], "regex '/^a/i'");

// No match: first() is null, count() is 0.
const none = new JsnqPipeline(orders).pipe(where('total', '>', 1000));
expectEqual(none.first(), null, 'first() is null when nothing matches');

// Custom comparison operators are registered once for the whole process.
registerOperator('isEven', (actual) => typeof actual === 'number' && actual % 2 === 0);
const even = new JsnqPipeline(orders).pipe(where('id', 'isEven', undefined));
expectEqual(dataOf<Order>(even.all()).map((o) => o.id), [2, 4], 'custom isEven operator');

// Read-only queries never touch the input.
expectEqual(orders.length, 4, 'the input array is unchanged by queries');
