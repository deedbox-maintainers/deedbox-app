// Client-money statements: generated/unissued/issued per ledger with
// numbers and artefacts; issue exactly once, defaulting to email.

import { requirePrincipal } from '@/lib/auth'
import { moneyStatementsScreen } from '@/lib/reads/money'
import { Page, Panel, DataTable, Notices, Badge, fmtDate, fmtDateTime } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { generateMoneyStatementAction, issueMoneyStatementAction } from '../actions'

export default async function MoneyStatementsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await moneyStatementsScreen(p)

  return (
    <Page
      title="Client-money statements"
      lead="What the firm tells clients about their money. Generated from the ledger's own lines, numbered, stored — and issued exactly once."
    >
      <Notices searchParams={sp} />
      <Panel title="Generate">
        <form action={generateMoneyStatementAction} className="flex flex-wrap items-end gap-3">
          <div className="w-32">
            <Field label="Ledger #">
              <TextInput name="matter_ledger" required inputMode="numeric" />
            </Field>
          </div>
          <div className="w-40">
            <Field label="Period start">
              <TextInput name="period_start" type="date" required />
            </Field>
          </div>
          <div className="w-40">
            <Field label="Period end">
              <TextInput name="period_end" type="date" required />
            </Field>
          </div>
          <div className="pb-3">
            <SubmitButton>Generate</SubmitButton>
          </div>
        </form>
        <p className="mt-1 text-xs text-neutral-400">
          The annual run is the scheduler's — it generates one per active ledger on the pack's
          calendar through the same operation.
        </p>
      </Panel>
      <Panel title="Statements">
        <DataTable
          headers={['Number', 'Ledger', 'Matter', 'Period', 'State', 'Issue']}
          rows={rows.map((s) => [
            String(s.statement_number),
            String(s.ledger_number),
            s.matter_number ? String(s.matter_number) : '—',
            `${fmtDate(s.period_start)} – ${fmtDate(s.period_end)}`,
            s.issued_at ? (
              <Badge key="s" tone="green">
                issued {fmtDateTime(s.issued_at)} ({String(s.issue_channel)})
              </Badge>
            ) : (
              <Badge key="s" tone="amber">generated, unissued</Badge>
            ),
            !s.issued_at ? (
              <form key="i" action={issueMoneyStatementAction} className="flex items-center gap-1">
                <input type="hidden" name="statement" value={s.id as number} />
                <Select name="channel" defaultValue="email" className="!w-24">
                  <option value="email">Email</option>
                  <option value="print">Print</option>
                  <option value="portal">Portal</option>
                </Select>
                <TextInput name="recipient" placeholder="Recipient" className="!w-40" />
                <SubmitButton tone="quiet">Issue once</SubmitButton>
              </form>
            ) : (
              '—'
            ),
          ])}
          emptyState="No statements yet."
        />
      </Panel>
    </Page>
  )
}
