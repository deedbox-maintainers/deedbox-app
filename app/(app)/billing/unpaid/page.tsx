// The unpaid-bills register — the reminder engine's human face: age,
// amount, last contact, next planned step, dispute/arrangement/hold flags;
// exhausted sequences are visible here rather than alerted.

import { requirePrincipal } from '@/lib/auth'
import { unpaidBills } from '@/lib/reads/billing'
import { matterFilterOptions } from '@/lib/reads/matters'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { Select, SubmitButton, TextInput } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'

export default async function UnpaidBillsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const [rows, options] = await Promise.all([
    unpaidBills(p, {
      matter: sp.matter ? Number(sp.matter) : undefined,
      lawyer: sp.lawyer ? Number(sp.lawyer) : undefined,
      office: sp.office ? Number(sp.office) : undefined,
      ageBand: sp.age || undefined,
    }),
    matterFilterOptions(p),
  ])

  return (
    <Page
      title="Unpaid bills"
      lead="Every issued bill with money outstanding. The reminder engine works this list; exhausted sequences surface here for a human decision."
    >
      <Notices searchParams={sp} />
      <Panel>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          <div className="w-28">
            <TextInput name="matter" placeholder="Matter #" defaultValue={sp.matter ?? ''} inputMode="numeric" />
          </div>
          <Select name="lawyer" defaultValue={sp.lawyer ?? ''} className="w-40">
            <option value="">Any lawyer</option>
            {options.lawyers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          <Select name="office" defaultValue={sp.office ?? ''} className="w-36">
            <option value="">Any office</option>
            {options.offices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <Select name="age" defaultValue={sp.age ?? ''} className="w-32">
            <option value="">Any age</option>
            <option value="0–30">0–30</option>
            <option value="31–60">31–60</option>
            <option value="61–90">61–90</option>
            <option value="91–180">91–180</option>
            <option value="180+">180+</option>
          </Select>
          <SubmitButton tone="quiet">Filter</SubmitButton>
        </form>
        <DataTable
          headers={['Bill', 'Matter', 'Payer', 'Outstanding', 'Overdue', 'Last contact', 'Next step', 'Flags']}
          rows={rows.map((r) => [
            <RowLink key="b" href={`/billing/bills/${r.id}`}>
              {String(r.bill_number)}
            </RowLink>,
            <RowLink key="m" href={`/matters/${r.matter}`}>
              {String(r.matter_number)}
            </RowLink>,
            String(r.payer_name),
            Number(r.outstanding).toFixed(2),
            <Badge key="a" tone={r.age_days === 0 ? 'neutral' : Number(r.age_days) > 60 ? 'red' : 'amber'}>
              {r.age_days === 0 ? 'not yet due' : `${r.age_days}d (${r.age_band})`}
            </Badge>,
            r.last_contact ? fmtDateTime(r.last_contact) : '—',
            r.reminder_status === 'exhausted' ? (
              <Badge key="x" tone="red">sequence exhausted — yours now</Badge>
            ) : r.next_step_at ? (
              fmtDateTime(r.next_step_at)
            ) : (
              String(r.reminder_status ?? '—').replace(/_/g, ' ')
            ),
            <span key="f" className="flex gap-1">
              {r.disputed ? <Badge tone="amber">disputed</Badge> : null}
              {r.arranged ? <Badge tone="blue">arrangement</Badge> : null}
              {r.billing_hold ? <Badge tone="violet">hold</Badge> : null}
            </span>,
          ])}
          emptyState="Nothing outstanding."
        />
      </Panel>
    </Page>
  )
}
