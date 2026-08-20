// The reconciliation workspace: unmatched statement lines beside
// unmatched book transactions, zero-sum match grouping, typed exceptions
// with intrinsic ages (stale ones highlighted), the LIVE certification
// equation with its remainder, and certify — enabled only at a zero
// remainder; the schema re-proves everything at the moment of certification.

import { requirePrincipal } from '@/lib/auth'
import { reconWorkspace } from '@/lib/reads/money'
import { Page, Panel, DataTable, DetailList, Notices, Badge, EmptyState, fmtDate } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  ingestLinesAction,
  buildReconAction,
  matchAction,
  exceptionAction,
  resolveExceptionAction,
  certifyReconAction,
} from '../../actions'

export default async function ReconPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const w = await reconWorkspace(p, Number(id))

  return (
    <Page
      title={`Reconcile — ${w.account.name}`}
      lead="Match the bank's statement lines to the book's transactions; what cannot match becomes a typed exception with its arising date. Certification demands the equation to the cent: statement + unbanked receipts − unpresented payments ± bank errors = the book total."
    >
      <Notices searchParams={sp} />

      {!w.recon ? (
        <Panel title="Start a reconciliation">
          <form action={buildReconAction} className="flex max-w-md items-end gap-2">
            <input type="hidden" name="account" value={w.account.id} />
            <div className="w-40">
              <Field label="Statement date">
                <TextInput name="statement_date" type="date" required />
              </Field>
            </div>
            <div className="w-36">
              <Field label="Statement balance">
                <TextInput name="statement_balance" required inputMode="decimal" />
              </Field>
            </div>
            <div className="pb-3">
              <SubmitButton>Build workspace</SubmitButton>
            </div>
          </form>
        </Panel>
      ) : (
        <>
          <Panel
            title={`In progress — statement of ${fmtDate(w.recon.statement_date)}`}
            actions={
              w.equation && w.equation.remainder === 0 ? (
                <InlineAction
                  action={certifyReconAction}
                  fields={{ account: w.account.id, reconciliation: w.recon.id as number }}
                  label="Certify — locks the matches forever"
                  tone="danger"
                />
              ) : (
                <Badge tone="amber">certify disabled — remainder not zero</Badge>
              )
            }
          >
            {w.equation ? (
              <DetailList
                items={[
                  ['Bank says', w.equation.statementBalance.toFixed(2)],
                  ['+ receipts not yet banked', w.equation.unbanked.toFixed(2)],
                  ['− payments not yet presented', w.equation.unpresented.toFixed(2)],
                  ['± bank errors', w.equation.bankErrors.toFixed(2)],
                  ['Book total', w.equation.bookTotal.toFixed(2)],
                  [
                    'Remainder',
                    <Badge key="r" tone={w.equation.remainder === 0 ? 'green' : 'red'}>
                      {w.equation.remainder.toFixed(2)}
                    </Badge>,
                  ],
                ]}
              />
            ) : null}
          </Panel>

          <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
            <Panel title={`Unmatched statement lines (${w.unmatchedLines.length})`}>
              <form action={matchAction}>
                <input type="hidden" name="account" value={w.account.id} />
                <input type="hidden" name="reconciliation" value={w.recon.id as number} />
                <DataTable
                  headers={['', 'Date', 'Amount', 'Description']}
                  rows={w.unmatchedLines.map((l) => [
                    <input key="cb" type="checkbox" name="m_line" value={l.id as number} className="h-4 w-4" />,
                    fmtDate(l.line_date),
                    Number(l.amount).toFixed(2),
                    String(l.description),
                  ])}
                  emptyState="All statement lines matched — nothing to reconcile for this date."
                />
                <h3 className="mb-1 mt-4 text-sm font-medium text-neutral-700">
                  Unmatched book transactions ({w.unmatchedTxns.length})
                </h3>
                <DataTable
                  headers={['', 'Date', 'Amount', 'What', 'Ledger']}
                  rows={w.unmatchedTxns.map((t) => [
                    <input key="cb" type="checkbox" name="m_txn" value={t.id as number} className="h-4 w-4" />,
                    fmtDate(t.effective_date),
                    Number(t.signed_amount).toFixed(2),
                    String(t.txn_kind).replace(/_/g, ' '),
                    String(t.ledger_number ?? '—'),
                  ])}
                  emptyState="Every book transaction is matched."
                />
                <div className="mt-3 border-t border-neutral-100 pt-3">
                  <SubmitButton tone="quiet">Match the ticked rows (must net to zero)</SubmitButton>
                </div>
              </form>
            </Panel>

            <div>
              <Panel title={`Exceptions (${w.exceptions.length})`}>
                <DataTable
                  headers={['Type', 'Amount', 'Arising', 'Age', '']}
                  rows={w.exceptions.map((e) => [
                    String(e.exception_type).replace(/_/g, ' '),
                    Number(e.amount).toFixed(2),
                    fmtDate(e.arising_date),
                    <Badge key="a" tone={Number(e.age_days) > w.staleDays ? 'red' : 'neutral'}>
                      {String(e.age_days)}d{Number(e.age_days) > w.staleDays ? ' — stale, review' : ''}
                    </Badge>,
                    <form key="rs" action={resolveExceptionAction} className="flex items-center gap-1">
                      <input type="hidden" name="account" value={w.account.id} />
                      <input type="hidden" name="reconciliation" value={w.recon!.id as number} />
                      <input type="hidden" name="exception" value={e.id as number} />
                      <TextInput name="resolution_note" placeholder="Resolve — note" className="!w-32" />
                      <SubmitButton tone="quiet">Resolve</SubmitButton>
                    </form>,
                  ])}
                  emptyState="No exceptions."
                />
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-sky-700">Record an exception</summary>
                  <form action={exceptionAction} className="mt-2 max-w-md">
                    <input type="hidden" name="account" value={w.account.id} />
                    <input type="hidden" name="reconciliation" value={w.recon.id as number} />
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Type">
                        <Select name="exception_type" defaultValue="unbanked_receipt">
                          <option value="unbanked_receipt">Receipt not yet banked</option>
                          <option value="unpresented_payment">Payment not yet presented</option>
                          <option value="bank_error">Bank error</option>
                        </Select>
                      </Field>
                      <Field label="Linked to">
                        <Select name="linked_type" defaultValue="transaction">
                          <option value="transaction">Book transaction #</option>
                          <option value="statement_line">Statement line #</option>
                          <option value="instrument">Instrument #</option>
                        </Select>
                      </Field>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Field label="#">
                        <TextInput name="linked" required inputMode="numeric" />
                      </Field>
                      <Field label="Amount">
                        <TextInput name="amount" required inputMode="decimal" />
                      </Field>
                      <Field label="Arising date">
                        <TextInput name="arising_date" type="date" required />
                      </Field>
                    </div>
                    <SubmitButton tone="quiet">Record</SubmitButton>
                  </form>
                </details>
              </Panel>
            </div>
          </div>
        </>
      )}

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <Panel title="Take in statement lines (manual)">
          <form action={ingestLinesAction}>
            <input type="hidden" name="account" value={w.account.id} />
            {[0, 1, 2].map((i) => (
              <div key={i} className="grid grid-cols-3 gap-2">
                <Field label={i === 0 ? 'Date' : ''}>
                  <TextInput name="line_date" type="date" />
                </Field>
                <Field label={i === 0 ? 'Amount (±)' : ''}>
                  <TextInput name="line_amount" inputMode="decimal" />
                </Field>
                <Field label={i === 0 ? 'Description' : ''}>
                  <TextInput name="line_desc" />
                </Field>
              </div>
            ))}
            <SubmitButton tone="quiet">Take in</SubmitButton>
          </form>
        </Panel>
        <Panel title="Certified history">
          {w.history.length === 0 ? (
            <EmptyState>No certified reconciliations yet.</EmptyState>
          ) : (
            <DataTable
              headers={['Statement date', 'Balance', 'Certified']}
              rows={w.history.map((h) => [
                fmtDate(h.statement_date),
                Number(h.statement_balance).toFixed(2),
                fmtDate(h.certified_at),
              ])}
            />
          )}
        </Panel>
      </div>
    </Page>
  )
}
