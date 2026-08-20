// List manager: all lists; items with position, active flag, shipped
// badges, chargeability on time categories, usage counts; refusals name the
// blocking usages.

import { requirePrincipal } from '@/lib/auth'
import { listManager } from '@/lib/reads/config'
import { Page, Panel, Badge, Notices, EmptyState } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  addListAction,
  addItemAction,
  relabelItemAction,
  setChargeabilityAction,
  setItemActiveAction,
  deleteItemAction,
} from '../actions'

export default async function ListsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const { lists, items } = await listManager(p)
  return (
    <Page
      title="Lists"
      lead="The choice lists behind pickers across the product. Shipped items are permanent; items in use deactivate rather than delete; time categories always know whether they count as chargeable."
    >
      <Notices searchParams={sp} />
      {lists.map((l) => {
        const li = items.filter((i) => i.list === l.id)
        const isTime = l.purpose_key === 'time_categories'
        return (
          <Panel key={l.id} title={`${l.name} (${l.purpose_key})`}>
            {li.length === 0 ? <EmptyState>No items yet — add the first.</EmptyState> : null}
            <div className="divide-y divide-neutral-100">
              {li.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                  <span className="w-6 text-right tabular-nums text-neutral-400">{i.position}</span>
                  <span className={i.active ? 'text-neutral-800' : 'text-neutral-400 line-through'}>
                    {i.label}
                  </span>
                  {i.shipped_key ? <Badge tone="violet">shipped</Badge> : null}
                  {isTime ? (
                    <Badge tone={i.counts_as_chargeable ? 'green' : 'neutral'}>
                      {i.counts_as_chargeable ? 'chargeable' : 'non-chargeable'}
                    </Badge>
                  ) : null}
                  <span className="text-xs text-neutral-400">{i.usage} usage(s)</span>
                  <span className="grow" />
                  <form action={relabelItemAction} className="flex items-center gap-1">
                    <input type="hidden" name="item" value={i.id} />
                    <TextInput name="label" defaultValue={i.label} className="w-36" />
                    <SubmitButton tone="quiet">Rename</SubmitButton>
                  </form>
                  {isTime && !i.shipped_key ? (
                    <form action={setChargeabilityAction} className="inline">
                      <input type="hidden" name="item" value={i.id} />
                      <input
                        type="hidden"
                        name="counts_as_chargeable"
                        value={i.counts_as_chargeable ? '' : 'on'}
                      />
                      <SubmitButton tone="quiet">
                        {i.counts_as_chargeable ? 'Make non-chargeable' : 'Make chargeable'}
                      </SubmitButton>
                    </form>
                  ) : null}
                  {!i.shipped_key ? (
                    <>
                      <form action={setItemActiveAction} className="inline">
                        <input type="hidden" name="item" value={i.id} />
                        <input type="hidden" name="active" value={i.active ? '' : 'on'} />
                        <SubmitButton tone="quiet">{i.active ? 'Deactivate' : 'Reactivate'}</SubmitButton>
                      </form>
                      {i.usage === 0 ? (
                        <InlineAction action={deleteItemAction} fields={{ item: i.id }} label="Delete" tone="danger" />
                      ) : null}
                    </>
                  ) : null}
                </div>
              ))}
            </div>
            <form action={addItemAction} className="mt-3 flex items-end gap-2">
              <input type="hidden" name="list" value={l.id} />
              <div>
                <Field label="New item">
                  <TextInput name="label" required className="w-48" />
                </Field>
              </div>
              {isTime ? (
                <div>
                  <Field label="Counts as chargeable?">
                    <Select name="chargeable" required>
                      <option value="">— choose —</option>
                      <option value="true">chargeable</option>
                      <option value="false">non-chargeable</option>
                    </Select>
                  </Field>
                </div>
              ) : null}
              <div className="pb-3">
                <SubmitButton tone="quiet">Add</SubmitButton>
              </div>
            </form>
          </Panel>
        )
      })}
      <Panel title="Create a firm list">
        <form action={addListAction} className="flex max-w-lg items-end gap-3">
          <div className="grow">
            <Field label="Name">
              <TextInput name="name" required />
            </Field>
          </div>
          <div className="grow">
            <Field label="Key" hint="Becomes custom.<key>">
              <TextInput name="key" required pattern="[a-z][a-z0-9_]*" />
            </Field>
          </div>
          <div className="pb-3">
            <SubmitButton>Create</SubmitButton>
          </div>
        </form>
      </Panel>
    </Page>
  )
}
