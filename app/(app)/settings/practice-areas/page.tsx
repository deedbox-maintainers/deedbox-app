// Practice area administration: the areas, the relatable-pairs matrix
// with the absent-pair default badge, and the conflict-resolution flag
// (compliance-relevant — its changes register privileged). Field-set and
// workflow-template bindings live with their owning administrations.

import { requirePrincipal } from '@/lib/auth'
import { practiceAreasAdmin } from '@/lib/reads/matters'
import { Page, Panel, DataTable, Notices, Badge } from '@/components/ui'
import { Field, TextInput, SubmitButton, InlineAction, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  addAreaAction,
  renameAreaAction,
  setAreaActiveAction,
  setConflictFlagAction,
  setPairAction,
} from './actions'

export default async function PracticeAreasPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const data = await practiceAreasAdmin(p)
  const active = data.areas.filter((a) => a.active)
  const pairKey = (a: number, b: number) => (a <= b ? `${a}:${b}` : `${b}:${a}`)
  const pairMap = new Map(data.pairs.map((x) => [pairKey(x.area_a, x.area_b), x.allowed]))

  return (
    <Page
      title="Practice areas"
      lead="The firm's areas of work. Each area can demand a resolved conflict check before a matter opens, and the matrix below governs which areas' matters may be related."
    >
      <Notices searchParams={sp} />

      <Panel title="Areas">
        <DataTable
          headers={['Area', 'Matters', 'Templates', 'Conflict check to open', 'State', '', '']}
          rows={data.areas.map((a) => [
            <form key="rn" action={renameAreaAction} className="flex items-center gap-1">
              <input type="hidden" name="area" value={a.id} />
              <TextInput name="name" defaultValue={a.name} className="!w-44" />
              <SubmitButton tone="quiet">Rename</SubmitButton>
            </form>,
            String(a.matters),
            String(a.templates),
            <InlineAction
              key="cf"
              action={setConflictFlagAction}
              fields={{ area: a.id, require: a.requireConflictResolution ? '' : 'on' }}
              label={
                a.requireConflictResolution ? (
                  <span>
                    <Badge tone="amber">required</Badge> — lift
                  </span>
                ) : (
                  'not required — demand it'
                )
              }
            />,
            a.active ? <Badge key="s" tone="green">active</Badge> : <Badge key="s">inactive</Badge>,
            <InlineAction
              key="tg"
              action={setAreaActiveAction}
              fields={{ area: a.id, active: a.active ? '' : 'on' }}
              label={a.active ? 'Deactivate' : 'Reactivate'}
            />,
            '',
          ])}
          emptyState="No practice areas yet — create the first below."
        />
        <form action={addAreaAction} className="mt-4 max-w-md border-t border-neutral-100 pt-3">
          <Field label="New practice area">
            <TextInput name="name" required />
          </Field>
          <Checkbox name="require_conflict" label="Demand a resolved conflict check before matters open in this area" />
          <SubmitButton tone="quiet">Add</SubmitButton>
        </form>
      </Panel>

      <Panel
        title="Which areas' matters may be related"
        actions={
          <Badge tone={data.absentDefault ? 'green' : 'red'}>
            no rule = {data.absentDefault ? 'allowed' : 'forbidden'}
          </Badge>
        }
      >
        <p className="mb-3 text-sm text-neutral-500">
          Click a cell to flip it. Cells with no recorded rule follow the firm default shown above
          (the setting matter.relations_absent_means_allowed).
        </p>
        <div className="overflow-x-auto">
          <table className="border-collapse text-sm">
            <thead>
              <tr>
                <th className="px-2 py-1.5" />
                {active.map((a) => (
                  <th key={a.id} className="px-2 py-1.5 text-left font-medium text-neutral-500">
                    {a.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {active.map((row) => (
                <tr key={row.id} className="border-t border-neutral-100">
                  <th className="px-2 py-1.5 text-left font-medium text-neutral-500">{row.name}</th>
                  {active.map((col) => {
                    const recorded = pairMap.get(pairKey(row.id, col.id))
                    const effective = recorded ?? data.absentDefault
                    return (
                      <td key={col.id} className="px-2 py-1.5">
                        <InlineAction
                          action={setPairAction}
                          fields={{
                            area_a: row.id,
                            area_b: col.id,
                            allowed: effective ? 'false' : 'true',
                          }}
                          label={
                            <Badge tone={effective ? 'green' : 'red'}>
                              {effective ? 'allowed' : 'forbidden'}
                              {recorded === undefined ? ' (default)' : ''}
                            </Badge>
                          }
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </Page>
  )
}
