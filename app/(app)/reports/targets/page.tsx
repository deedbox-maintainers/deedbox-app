// Targets & groups: per person or group, each metric with its period.
// Targets feed reporting only — they gate nothing.

import { requirePrincipal } from '@/lib/auth'
import { targetsScreen } from '@/lib/reads/operations'
import { Page, Panel, DataTable, EmptyState, Notices, personName } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { replaceTargetsAction } from '../actions'

const METRICS = ['hours_worked', 'billable_hours', 'amount_billed', 'amount_collected'] as const

export default async function TargetsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const d = await targetsScreen(p)

  return (
    <Page title="Targets & groups" lead="Targets feed reporting only. Setting a person's targets replaces their whole set for the period.">
      <Notices searchParams={sp} />
      <Panel title="Targets in force">
        {d.targets.length === 0 ? (
          <EmptyState>No targets — targets feed reporting only.</EmptyState>
        ) : (
          <DataTable
            headers={['Who', 'Metric', 'Amount', 'Period', 'From', 'To']}
            rows={d.targets.map((t) => [
              t.staff_name ? personName(t.staff_name) : String(t.group_name ?? `${t.subject_kind} #${t.subject}`),
              String(t.metric).replace(/_/g, ' '),
              <span key="a" className="tabular-nums">{Number(t.amount).toFixed(2)}</span>,
              String(t.period_kind),
              String(t.period_start),
              t.period_end ? String(t.period_end) : '—',
            ])}
          />
        )}
      </Panel>
      {d.manage ? (
        <Panel title="Replace a person's targets">
          <form action={replaceTargetsAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="subject_kind" value="staff" />
            <Field label="Person">
              <Select name="subject">
                {d.staff.map((s) => (
                  <option key={String(s.id)} value={String(s.id)}>
                    {personName(s.person_name)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Period">
              <Select name="period_kind">
                <option value="month">month</option>
                <option value="quarter">quarter</option>
                <option value="year">year</option>
                <option value="week">week</option>
              </Select>
            </Field>
            <Field label="Period start">
              <TextInput name="period_start" type="date" />
            </Field>
            {METRICS.map((m) => (
              <Field key={m} label={m.replace(/_/g, ' ')}>
                <input type="hidden" name="metric" value={m} />
                <TextInput name="amount" type="number" step="0.01" />
              </Field>
            ))}
            <SubmitButton>Replace targets</SubmitButton>
          </form>
          <p className="mt-2 text-xs text-neutral-500">
            Leave a metric at zero to drop it. Groups: {d.groups.length} defined.
          </p>
        </Panel>
      ) : null}
    </Page>
  )
}
