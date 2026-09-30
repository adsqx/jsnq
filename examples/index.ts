// Runs every numbered example in order. `npm run examples` executes this file with bun.
export {};

for (const name of [
  '01-query-flat-array',
  '02-update-nested-tree',
  '03-structural-move-copy',
  '04-data-engine-paths',
  '05-copy-on-write',
  '06-typed-paths',
]) {
  console.log(`\n== ${name} ==`);
  await import(`./${name}`);
}
console.log('\nAll examples passed.');
