// Field manager: tabs by scope; pack-owned definitions read-only with
// their owning version; sets; per-field value counts.

import { requirePrincipal } from '@/lib/auth'
import { fieldManager } from '@/lib/reads/config'
import { Page, Panel, Badge, Notices, EmptyState } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { defineFieldAction, setFieldActiveAction, defineSetAction } from '../actions'

export default async function FieldsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const { definitions, sets } = await fieldManager(p)
  const scopes = ['party', 'matter', 'intake', 'pack_object'] as const
  return (
    <Page
      title="Custom fields"
      lead="Firm-defined fields on people, matters and intake records. A field's type and key never change (a type change is a new field); deactivating keeps every recorded value."
    >
      <Notices searchParams={sp} />
      {scopes.map((scope) => {
        const defs = definitions.filter((d) => d.scope === scope)
        if (scope === 'pack_object' && defs.length === 0) return null
        return (
          <Panel key={scope} title={`${scope.replace('_', ' ')} fields`}>
            {defs.length === 0 ? (
              <EmptyState>No firm fields defined.</EmptyState>
            ) : (
              <div className="divide-y divide-neutral-100">
                {defs.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                    <span className={d.active ? 'font-medium text-neutral-800' : 'text-neutral-400 line-through'}>
                      {d.label}
                    </span>
                    <code className="text-xs text-neutral-400">{d.key}</code>
                    <Badge tone="blue">{d.data_type}</Badge>
                    {d.required ? <Badge tone="amber">required</Badge> : null}
                    {d.searchable ? <Badge tone="neutral">searchable</Badge> : null}
                    {d.owner_pack_version ? (
                      <Badge tone="violet">pack {d.pack_version_label}</Badge>
                    ) : null}
                    <span className="text-xs text-neutral-400">{d.value_count} value(s)</span>
                    <span className="grow" />
                    {d.owner_pack_version === null ? (
                      <form action={setFieldActiveAction} className="inline">
                        <input type="hidden" name="definition" value={d.id} />
                        <input type="hidden" name="active" value={d.active ? '' : 'on'} />
                        <SubmitButton tone="quiet">{d.active ? 'Deactivate' : 'Reactivate'}</SubmitButton>
                      </form>
                    ) : (
                      <span className="text-xs text-neutral-400">read-only (pack-owned)</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )
      })}
      <Panel title="Define a field">
        <form action={defineFieldAction} className="grid max-w-3xl grid-cols-2 gap-x-4 md:grid-cols-3">
          <Field label="Where it lives">
            <Select name="scope">
              <option value="matter">Matter</option>
              <option value="party">Person / organisation</option>
              <option value="intake">Intake record</option>
            </Select>
          </Field>
          <Field label="Label">
            <TextInput name="label" required />
          </Field>
          <Field label="Key" hint="Machine key; permanent.">
            <TextInput name="key" required pattern="[a-z][a-z0-9_]*" />
          </Field>
          <Field label="Type" hint="Permanent. A choice field creates its own list.">
            <Select name="data_type">
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
              <option value="choice">Choice</option>
              <option value="party_link">Link to a person</option>
            </Select>
          </Field>
          <Field label="Field set (optional)">
            <Select name="field_set">
              <option value="">—</option>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.scope})
                </option>
              ))}
            </Select>
          </Field>
          <div className="pt-6">
            <Checkbox name="required" label="Required" />
            <Checkbox name="searchable" label="Searchable" defaultChecked />
          </div>
          <div>
            <SubmitButton>Define</SubmitButton>
          </div>
        </form>
      </Panel>
      <Panel title="Field sets">
        {sets.length === 0 ? <EmptyState>No sets — sets group and order fields.</EmptyState> : (
          <ul className="mb-3 text-sm text-neutral-600">
            {sets.map((s) => (
              <li key={s.id}>
                {s.name} <Badge tone="neutral">{s.scope}</Badge>
              </li>
            ))}
          </ul>
        )}
        <form action={defineSetAction} className="flex max-w-md items-end gap-3">
          <div className="grow">
            <Field label="Set name">
              <TextInput name="name" required />
            </Field>
          </div>
          <div>
            <Field label="Scope">
              <Select name="scope">
                <option value="matter">Matter</option>
                <option value="intake">Intake</option>
              </Select>
            </Field>
          </div>
          <div className="pb-3">
            <SubmitButton tone="quiet">Create</SubmitButton>
          </div>
        </form>
      </Panel>
    </Page>
  )
}
