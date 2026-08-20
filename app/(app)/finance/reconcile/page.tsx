// Reconciliation workbench: per bank account — import, auto-run the
// rules, then the verbs per unmatched line with rule and bill
// suggestions inline.

import { requirePrincipal } from '@/lib/auth'
import { glBankAccounts, glWorkbench } from '@/lib/reads/gl'
import { Page, Panel, Badge, Notices, EmptyState } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import Link from 'next/link'
import {
  createBankAccountAction,
  importCsvAction,
  autoReconcileAction,
  receiveAction,
  spendAction,
  matchBillAction,
  transferAction,
  ignoreAction,
} from '../actions'

export default async function ReconcilePage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const accounts = await glBankAccounts(p)
  const selected = Number(sp.account ?? 0) || (accounts[0]?.id as number | undefined) || 0
  const bench = selected ? await glWorkbench(p, selected) : null
  return (
    <Page
      title="Bank reconciliation"
      lead="Each bank line becomes exactly one posted journal — received, spent, a bill paid, a transfer — or is deliberately set aside. Rules can do the routine ones."
    >
      <Notices searchParams={sp} />

      <Panel title="Bank accounts">
        <div className="flex flex-wrap gap-2">
          {(accounts as Record<string, unknown>[]).map((a) => (
            <Link
              key={a.id as number}
              href={`/finance/reconcile?account=${a.id}`}
              className={`rounded border px-3 py-1.5 text-sm ${
                a.id === selected
                  ? 'border-neutral-900 bg-neutral-900 text-white'
                  : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50'
              }`}
            >
              {a.name as string} ({a.unmatched as number})
            </Link>
          ))}
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-neutral-500">Add a bank account</summary>
          <form action={createBankAccountAction} className="mt-2 flex max-w-2xl flex-wrap items-end gap-2">
            <Field label="Name"><TextInput name="name" required /></Field>
            <Field label="Chart code"><TextInput name="code" required placeholder="1001" /></Field>
            <Field label="Kind">
              <Select name="kind" defaultValue="bank">
                <option value="bank">bank</option>
                <option value="credit_card">credit card</option>
              </Select>
            </Field>
            <SubmitButton tone="quiet">Add</SubmitButton>
          </form>
        </details>
      </Panel>

      {bench ? (
        <>
          <Panel title={`Import a statement — ${bench.account.name as string}`}>
            <form action={importCsvAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="bank_account" value={selected} />
              <Field label="CSV file">
                <input type="file" name="file" accept=".csv,text/csv" className="text-sm" />
              </Field>
              <Field label="Date col"><TextInput name="col_date" defaultValue="0" className="w-16" /></Field>
              <Field label="Amount col"><TextInput name="col_amount" defaultValue="1" className="w-16" /></Field>
              <Field label="Description col"><TextInput name="col_description" defaultValue="2" className="w-16" /></Field>
              <SubmitButton tone="quiet">Import</SubmitButton>
            </form>
            <form action={autoReconcileAction} className="mt-2">
              <input type="hidden" name="bank_account" value={selected} />
              <SubmitButton tone="quiet">Run the rules</SubmitButton>
            </form>
          </Panel>

          <Panel title={`Waiting for you (${bench.lines.length})`}>
            {bench.lines.length === 0 ? (
              <EmptyState>Nothing unmatched on this account.</EmptyState>
            ) : (
              <div className="divide-y divide-neutral-100">
                {bench.lines.map((l) => (
                  <div key={l.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="tabular-nums text-neutral-500">{l.transaction_date.slice(0, 10)}</span>
                      <Badge tone={l.direction === 'in' ? 'green' : 'amber'}>
                        {l.direction === 'in' ? '+' : ''}{l.amount}
                      </Badge>
                      <span className="text-neutral-800">{l.description ?? l.reference ?? '—'}</span>
                      {l.ruleSuggestion ? (
                        <Badge tone="violet">rule: {l.ruleSuggestion.rule}</Badge>
                      ) : null}
                    </div>
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <form action={l.direction === 'in' ? receiveAction : spendAction} className="flex items-end gap-1.5">
                        <input type="hidden" name="line" value={l.id} />
                        <input type="hidden" name="bank_account" value={selected} />
                        <Select name="account" defaultValue={l.ruleSuggestion?.account ?? ''} className="w-56">
                          <option value="" disabled>
                            {l.direction === 'in' ? 'Income account…' : 'Expense account…'}
                          </option>
                          {(bench.accounts as Record<string, unknown>[]).map((a) => (
                            <option key={a.id as number} value={a.id as number}>
                              {a.code as string} {a.name as string}
                            </option>
                          ))}
                        </Select>
                        <Select name="tax_code" defaultValue="" className="w-32">
                          <option value="">no tax</option>
                          {(bench.taxCodes as Record<string, unknown>[]).map((t) => (
                            <option key={t.id as number} value={t.id as number}>{t.code as string}</option>
                          ))}
                        </Select>
                        <SubmitButton tone="quiet">{l.direction === 'in' ? 'Receive' : 'Spend'}</SubmitButton>
                      </form>
                      {l.billCandidates.length > 0 ? (
                        <form action={matchBillAction} className="flex items-end gap-1.5">
                          <input type="hidden" name="line" value={l.id} />
                          <input type="hidden" name="bank_account" value={selected} />
                          <Select name="bill" className="w-56" defaultValue={l.billCandidates[0].id}>
                            {l.billCandidates.map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.contact_name} {b.bill_number ?? `#${b.id}`} owes {b.owing}
                              </option>
                            ))}
                          </Select>
                          <SubmitButton tone="quiet">Pay bill</SubmitButton>
                        </form>
                      ) : null}
                      {(bench.otherBanks as Record<string, unknown>[]).length > 0 ? (
                        <form action={transferAction} className="flex items-end gap-1.5">
                          <input type="hidden" name="line" value={l.id} />
                          <input type="hidden" name="bank_account" value={selected} />
                          <Select name="other_bank_account" className="w-44">
                            {(bench.otherBanks as Record<string, unknown>[]).map((b) => (
                              <option key={b.id as number} value={b.id as number}>{b.name as string}</option>
                            ))}
                          </Select>
                          <SubmitButton tone="quiet">Transfer</SubmitButton>
                        </form>
                      ) : null}
                      <form action={ignoreAction}>
                        <input type="hidden" name="line" value={l.id} />
                        <input type="hidden" name="bank_account" value={selected} />
                        <SubmitButton tone="quiet">Set aside</SubmitButton>
                      </form>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      ) : (
        <EmptyState>Add a bank account to begin reconciling.</EmptyState>
      )}
    </Page>
  )
}
