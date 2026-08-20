// The dormant balances queue: open cases with age and contact attempts
// against any pack minimum, and the permanent remittance register beneath —
// it survives matter closure by design.

import { requirePrincipal } from '@/lib/auth'
import { dormantQueue } from '@/lib/reads/money'
import { Page, Panel, DataTable, Notices, RowLink, Badge, EmptyState, fmtDate, fmtDateTime } from '@/components/ui'
import { TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { contactAttemptAction, resolveDormantAction } from '../actions'

export default async function DormantPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const q = await dormantQueue(p)

  return (
    <Page
      title="Dormant client money"
      lead="Balances that stopped moving. Contact attempts are recorded with evidence; remitting to the authority runs through the payment ceremony and lands on the permanent register below."
    >
      <Notices searchParams={sp} />
      <Panel title="Open cases">
        {q.cases.length === 0 ? (
          <EmptyState>No dormant balances detected.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {q.cases.map((c) => (
              <li key={c.id as number} className="rounded-md border border-neutral-200 p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge tone="amber">{String(c.state).replace(/_/g, ' ')}</Badge>
                  <RowLink href={`/money/ledgers/${c.ledger}`}>{String(c.ledger_number)}</RowLink>
                  {c.matter_number ? <span className="text-neutral-500">{String(c.matter_number)}</span> : null}
                  <span className="tabular-nums">
                    balance {Number(c.balance_now).toFixed(2)} (was {Number(c.balance_at_detection).toFixed(2)} at detection)
                  </span>
                  <span className="text-neutral-500">
                    · last movement {c.last_movement ? fmtDateTime(c.last_movement) : 'unknown'} ·{' '}
                    {String(c.attempts)} contact attempt(s)
                  </span>
                </div>
                <ul className="mb-2 ml-4 list-disc text-xs text-neutral-500">
                  {q.attempts
                    .filter((a) => a.case === c.id)
                    .map((a, i) => (
                      <li key={i}>
                        {fmtDateTime(a.attempted_at)} · {String(a.channel)} — {String(a.evidence)}
                      </li>
                    ))}
                </ul>
                <div className="flex flex-wrap items-center gap-3">
                  <form action={contactAttemptAction} className="flex items-center gap-1">
                    <input type="hidden" name="case" value={c.id as number} />
                    <TextInput name="channel" placeholder="Channel" className="!w-24" />
                    <TextInput name="evidence" placeholder="Evidence" className="!w-48" />
                    <SubmitButton tone="quiet">Record attempt</SubmitButton>
                  </form>
                  <form action={resolveDormantAction} className="flex items-center gap-1">
                    <input type="hidden" name="case" value={c.id as number} />
                    <TextInput name="reason" placeholder="Resolve — reason" className="!w-40" />
                    <SubmitButton tone="quiet">Resolve</SubmitButton>
                  </form>
                  <span className="text-xs text-neutral-400">
                    Remit = a remittance-purpose payment through{' '}
                    <RowLink href="/money/payments">the payment ceremony</RowLink> (pack minimum
                    attempts enforced there).
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Remittance register (permanent)">
        <DataTable
          headers={['Ledger', 'Authority', 'Amount', 'Date', 'Documentation']}
          rows={q.remittances.map((r) => [
            String(r.ledger_number),
            String(r.authority),
            Number(r.amount).toFixed(2),
            fmtDate(r.remitted_date),
            String(r.documentation),
          ])}
          emptyState="Nothing remitted."
        />
      </Panel>
    </Page>
  )
}
