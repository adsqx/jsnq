// Updating a deeply nested tree: where() matches nodes at any depth, update() edits them.
import { JsnqPipeline } from '@adsq/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';
import mergeUpdate from '@adsq/jsnq/operators/mergeUpdate';
import deleteKey from '@adsq/jsnq/operators/deleteKey';
import { dataOf, expectEqual, show } from './_check';

type Field = { id: string; type: string; label: string; required?: boolean; fields?: Field[] };
type Form = { id: string; settings: { ui: { theme: string; density?: string } }; fields: Field[] };

const makeForm = (): Form => ({
  id: 'signup',
  settings: { ui: { theme: 'light' } },
  fields: [
    { id: 'name', type: 'text', label: 'Name' },
    {
      id: 'address',
      type: 'group',
      label: 'Address',
      fields: [
        { id: 'street', type: 'text', label: 'Street' },
        { id: 'city', type: 'text', label: 'City' },
      ],
    },
  ],
});

// 1. Without options a pipeline edits its input in place, so work on your own copy.
//    where('type', '===', 'text') matches EVERY node with that value, at any depth.
const form = makeForm();
new JsnqPipeline(form).pipe(where('type', '===', 'text'), update('required', true)).all();
show('required ids', form.fields.flatMap((f) => [f, ...(f.fields ?? [])]).filter((f) => f.required).map((f) => f.id));

// 2. immutable: true clones once, leaves the input alone and exposes the result on `.data`.
const original = makeForm();
const relabel = new JsnqPipeline(original, { immutable: true })
  .pipe(where('id', '===', 'city'), update('label', (current: unknown) => `${String(current)} / town`));
relabel.all();
expectEqual((relabel.data as Form).fields[1].fields?.[1].label, 'City / town', 'nested label rewritten in the clone');
expectEqual(original.fields[1].fields?.[1].label, 'City', 'the original form is untouched');

// 3. Deep "@" criteria: fields@id searches the nested `fields` arrays under each node.
const street = new JsnqPipeline(makeForm()).pipe(where('fields@id', '===', 'street'));
expectEqual(dataOf<Field>(street.all()).map((f) => f.label), ['Street'], "where('fields@id', ...) finds a nested field");

// 4. update() creates missing paths; mergeUpdate() merges objects (deep merge on request).
const themed = new JsnqPipeline(makeForm(), { immutable: true }).pipe(
  where('id', '===', 'signup'),
  mergeUpdate('settings', { ui: { density: 'compact' } }, { deep: true }),
  update('meta.editedBy', 'ann'),
);
themed.all();
expectEqual((themed.data as Form).settings.ui, { theme: 'light', density: 'compact' }, 'deep merge keeps sibling keys');
expectEqual((themed.data as unknown as { meta: unknown }).meta, { editedBy: 'ann' }, 'update() created meta.editedBy');

// 5. deleteKey() removes a key from each match.
const stripped = new JsnqPipeline(form, { immutable: true }).pipe(where('required', '===', true), deleteKey('required'));
expectEqual(stripped.all().length, 3, 'three fields had required: true');
expectEqual(JSON.stringify(stripped.data).includes('required'), false, 'required is gone from the clone');

// 6. dryRun() plans without writing; getStats() reports what would have happened.
const planned = new JsnqPipeline(form).dryRun().pipe(where('type', '===', 'group'), update('label', 'Where you live'));
planned.all();
expectEqual(planned.getStats().updates, 1, 'dry run counted one update');
expectEqual(form.fields[1].label, 'Address', 'dry run wrote nothing');
show('operations', planned.getStats().operations);
