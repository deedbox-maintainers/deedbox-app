// Staffing panel: current and past staffing, and the one dedicated
// change operation — responsibility hand-over, assisting additions, row
// endings — atomic with the workflow re-resolution proposal. A
// matter is never without a responsible lawyer.

import { requirePrincipal } from '@/lib/auth'
import { staffingPanel } from '@/lib/reads/matters'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { Field, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { changeStaffingAction } from '../../actions'

export default async function StaffingPanelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const panel = await staffingPanel(p, Number(id))
  const current = panel.staffing.filter((s) => s.toAt === null)
  const past = panel.staffing.filter((s) => s.toAt !== null)

  return (
    <Page
      title={`Staffing — ${panel.matter.matterNumber}`}
      lead={
        <span>
          {panel.matter.title} — <RowLink href={`/matters/${panel.matter.id}`}>back to the matter</RowLink>.
          A staffing change and its task re-assignment proposal are one atomic, recorded act; the
          re-pointed task owners are confirmed on the workflow side before anything moves.
        </span>
      }
    >
      <Notices searchParams={sp} />

      <Panel title="Current staffing">
        <DataTable
          headers={['Who', 'Role', 'Since', 'Standing']}
          rows={current.map((s) => [
            s.name,
            s.role === 'responsible_lawyer' ? (
              <Badge key="r" tone="blue">responsible lawyer</Badge>
            ) : (
              'assisting'
            ),
            fmtDateTime(s.fromAt),
            s.staffActive ? '' : <Badge key="i" tone="red">account inactive</Badge>,
          ])}
        />
      </Panel>

      <Panel title="Change staffing">
        <form action={changeStaffingAction} className="max-w-md">
          <input type="hidden" name="matter" value={panel.matter.id} />
          <Field
            label="Hand responsibility to"
            hint="Leave as-is to keep the current responsible lawyer; the mirror can never drift"
          >
            <Select name="new_responsible" defaultValue="">
              <option value="">(no change)</option>
              {panel.staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Add as assisting">
            <Select name="add_assisting" defaultValue="">
              <option value="">(nobody)</option>
              {panel.staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          {current.filter((s) => s.role === 'assisting').length > 0 ? (
            <div className="mb-3">
              <p className="mb-1 text-sm font-medium text-neutral-700">End assisting rows</p>
              {current
                .filter((s) => s.role === 'assisting')
                .map((s) => (
                  <label key={s.id} className="mb-2 flex items-center gap-2 text-sm text-neutral-700">
                    <input type="checkbox" name="end" value={s.id} className="h-4 w-4" />
                    {s.name} (since {fmtDateTime(s.fromAt)})
                  </label>
                ))}
            </div>
          ) : null}
          <SubmitButton>Apply change</SubmitButton>
        </form>
      </Panel>

      {past.length > 0 ? (
        <Panel title="Past staffing">
          <DataTable
            headers={['Who', 'Role', 'From', 'To']}
            rows={past.map((s) => [
              s.name,
              s.role.replace(/_/g, ' '),
              fmtDateTime(s.fromAt),
              fmtDateTime(s.toAt),
            ])}
          />
        </Panel>
      ) : null}
    </Page>
  )
}
