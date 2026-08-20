// Arrangements: broken queue prominent, instalment schedules with the
// cumulative-coverage position, reactivate/cancel, and creation.

import { requirePrincipal } from '@/lib/auth'
import { arrangementsScreen } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, RowLink, Badge, EmptyState, fmtDate } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { createArrangementAction, reactivateArrangementAction, cancelArrangementAction } from '../actions'

const STATE_TONES: Record<string, 'green' | 'red' | 'neutral' | 'blue'> = {
  active: 'green',
  broken: 'red',
  completed: 'neutral',
  cancelled: 'neutral',
}

export default async function ArrangementsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const data = await arrangementsScreen(p)

  return (
    <Page
      title="Payment arrangements"
      lead="Instalment plans over unpaid bills. Coverage is cumulative — any money in counts toward the earliest unpaid instalment; covered reminders stay stopped while the plan holds."
    >
      <Notices searchParams={sp} />

      <Panel title="Arrangements">
        {data.arrangements.length === 0 ? (
          <EmptyState>No arrangements.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {data.arrangements.map((a) => (
              <li key={a.id as number} className="rounded-md border border-neutral-200 p-3 text-sm">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge tone={STATE_TONES[String(a.state)] ?? 'neutral'}>{String(a.state)}</Badge>
                  <span className="font-medium">{String(a.client_name)}</span>
                  {a.matter_number ? (
                    <RowLink href={`/matters/${a.matter}`}>{String(a.matter_number)}</RowLink>
                  ) : (
                    <span className="text-neutral-400">across matters</span>
                  )}
                  <span className="text-neutral-500">
                    {Number(a.instalment_amount).toFixed(2)} {String(a.frequency).replace(/_/g, ' ')} ·{' '}
                    {String(a.paid)}/{String(a.instalment_count)} paid
                    {Number(a.missed) > 0 ? ` · ${a.missed} missed` : ''}
                    {a.covers_future_bills ? ' · covers future bills' : ''}
                  </span>
                </div>
                <div className="mb-2 flex flex-wrap gap-1">
                  {data.instalments
                    .filter((i) => i.arrangement === a.id)
                    .map((i) => (
                      <span
                        key={`${i.arrangement}-${i.sequence_no}`}
                        title={`#${i.sequence_no} due ${fmtDate(i.due_date)} — ${i.state}`}
                        className={`inline-block h-3 w-6 rounded-sm ${
                          i.state === 'paid'
                            ? 'bg-emerald-500'
                            : i.state === 'missed'
                              ? 'bg-red-500'
                              : i.state === 'collecting' || i.state === 'notified'
                                ? 'bg-sky-400'
                                : 'bg-neutral-200'
                        }`}
                      />
                    ))}
                </div>
                {a.state === 'broken' ? (
                  <form action={reactivateArrangementAction} className="flex items-end gap-2">
                    <input type="hidden" name="arrangement" value={a.id as number} />
                    <div className="w-40">
                      <Field label="Reactivate — first due date">
                        <TextInput name="new_first_due_date" type="date" required />
                      </Field>
                    </div>
                    <div className="pb-3">
                      <SubmitButton tone="quiet">Reactivate</SubmitButton>
                    </div>
                  </form>
                ) : null}
                {a.state === 'active' || a.state === 'broken' ? (
                  <form action={cancelArrangementAction} className="mt-1 flex items-end gap-2">
                    <input type="hidden" name="arrangement" value={a.id as number} />
                    <div className="w-64">
                      <Field label="Cancel — reason">
                        <TextInput name="reason" required />
                      </Field>
                    </div>
                    <div className="pb-3">
                      <SubmitButton tone="quiet">Cancel</SubmitButton>
                    </div>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="New arrangement">
        <form action={createArrangementAction} className="max-w-lg">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Client (party #)">
              <TextInput name="client_party" required inputMode="numeric" />
            </Field>
            <Field label="Bills covered" hint="Bill #s, comma-separated">
              <TextInput name="bills" required />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Instalment">
              <TextInput name="instalment_amount" required inputMode="decimal" />
            </Field>
            <Field label="How many">
              <TextInput name="instalment_count" required inputMode="numeric" />
            </Field>
            <Field label="First due">
              <TextInput name="first_due_date" type="date" required />
            </Field>
          </div>
          <Field label="Frequency">
            <Select name="frequency" defaultValue="monthly">
              <option value="weekly">Weekly</option>
              <option value="every_two_weeks">Every two weeks</option>
              <option value="monthly">Monthly</option>
            </Select>
          </Field>
          <Checkbox name="covers_future" label="New bills for this client join the plan automatically" />
          <SubmitButton>Create arrangement</SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
