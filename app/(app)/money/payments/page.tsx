// The payment workspace: drafts and submissions per state, the
// pending-authorisation queue (approve/reject inline, approvals counted
// against the frozen requirement), and the blocked list — refused payments
// with a resubmit action; their typed refusal reasons live on the refusal
// register, permanently.

import { requirePrincipal } from '@/lib/auth'
import { paymentWorkspace, moneyViewerFlags, paymentHistory, findLedgers } from '@/lib/reads/money'
import MatterPicker from '@/components/matter-picker'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { Field, TextInput, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  draftPaymentAction,
  submitPaymentAction,
  authorisePaymentAction,
  rejectPaymentAction,
  cancelPaymentAction,
  executePaymentAction,
  resubmitPaymentAction,
} from '../actions'

function payeeOf(r: Record<string, unknown>): string {
  return (r.payee_name as string) ?? (r.payee_description as string) ?? '—'
}

export default async function MoneyPaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const [w, flags] = await Promise.all([paymentWorkspace(p), moneyViewerFlags(p)])
  const history = await paymentHistory(p, {
    q: sp.q || undefined,
    from: sp.from || undefined,
    to: sp.to || undefined,
    limit: sp.q || sp.from || sp.to ? 200 : 25,
  })
  // the payment form's first step: the ledger, by the numbers a person knows
  const ledgerQ = (sp.ledger_q ?? '').trim()
  const matches = ledgerQ ? await findLedgers(p, ledgerQ) : []
  const chosen = matches.length === 1 ? matches[0] : matches.find((m) => m.ledgerNumber === ledgerQ) ?? null
  // payee bank fields come from the pack's own declaration; the catalogue's
  // neutral default covers a pack-silent installation
  const payeeFields = w.identifierSchema?.fields ?? [
    { key: 'account_label', label: 'Account label' },
    { key: 'account_number', label: 'Account number' },
  ]

  return (
    <Page
      title="Client-money payments"
      lead="Money leaving a client ledger follows the ceremony: draft → submit (the approval requirement freezes) → authorise (never the requester) → execute. A guard refusal blocks the payment and records itself — nothing is silently dropped."
    >
      <Notices searchParams={sp} />

      {w.pending.length > 0 ? (
        <Panel title={`Awaiting authorisation (${w.pending.length})`}>
          <DataTable
            headers={['Payment', 'Ledger', 'Payee', 'Amount', 'Reason', 'Requester', 'Approvals', '', '']}
            rows={w.pending.map((r) => [
              <RowLink key="rq" href={`/money/payments/${r.id}/requisition`}>{`#${String(r.id)}`}</RowLink>,
              <RowLink key="l" href={`/money/ledgers/${r.matter_ledger}`}>
                {String(r.ledger_number)}
              </RowLink>,
              payeeOf(r),
              Number(r.amount).toFixed(2),
              String(r.reason),
              String((r.requester_name as { family?: string })?.family ?? ''),
              `${String(r.approvals)} of ${String(r.required_authorisations)}`,
              flags.authorise && (r.requested_by !== p.id || flags.selfAuthorisation) ? (
                <InlineAction
                  key="ap"
                  action={authorisePaymentAction}
                  fields={{ payment: r.id as number }}
                  label="Approve"
                  tone="primary"
                />
              ) : r.requested_by === p.id ? (
                <Badge key="own" tone="amber">your own — another must decide</Badge>
              ) : (
                ''
              ),
              flags.authorise && (r.requested_by !== p.id || flags.selfAuthorisation) ? (
                <form key="rj" action={rejectPaymentAction} className="flex items-center gap-1">
                  <input type="hidden" name="payment" value={r.id as number} />
                  <TextInput name="reason" placeholder="Reject — reason" className="!w-32" />
                  <SubmitButton tone="quiet">Reject</SubmitButton>
                </form>
              ) : (
                ''
              ),
            ])}
          />
        </Panel>
      ) : (
        <Panel>
          <p className="text-sm text-neutral-500">Nothing awaiting authorisation.</p>
        </Panel>
      )}

      {w.blocked.length > 0 ? (
        <Panel title={`Blocked by a guard refusal (${w.blocked.length})`}>
          <DataTable
            headers={['Payment', 'Ledger', 'Payee', 'Amount', '', '']}
            rows={w.blocked.map((r) => [
              <RowLink key="rq" href={`/money/payments/${r.id}/requisition`}>{`#${String(r.id)}`}</RowLink>,
              String(r.ledger_number),
              payeeOf(r),
              Number(r.amount).toFixed(2),
              <RowLink key="reg" href="/money/refusals">
                the recorded reason
              </RowLink>,
              <form key="rs" action={resubmitPaymentAction} className="flex items-center gap-1">
                <input type="hidden" name="payment" value={r.id as number} />
                <TextInput name="instrument_number" placeholder="Bank transaction reference" className="!w-44" />
                <SubmitButton tone="quiet">Resubmit</SubmitButton>
              </form>,
            ])}
          />
        </Panel>
      ) : null}

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <div>
          <Panel title={`Authorised — ready to execute (${w.authorised.length})`}>
            <DataTable
              headers={['Payment', 'Ledger', 'Payee', 'Amount', '']}
              rows={w.authorised.map((r) => [
                <RowLink key="rq" href={`/money/payments/${r.id}/requisition`}>{`#${String(r.id)}`}</RowLink>,
                String(r.ledger_number),
                payeeOf(r),
                Number(r.amount).toFixed(2),
                <form key="ex" action={executePaymentAction} className="flex items-center gap-1">
                  <input type="hidden" name="payment" value={r.id as number} />
                  <TextInput name="instrument_number" placeholder="Bank transaction reference" className="!w-44" />
                  <SubmitButton tone="danger">Execute</SubmitButton>
                </form>,
              ])}
              emptyState="None ready."
            />
          </Panel>
          <Panel title={`Drafts (${w.drafts.length})`}>
            <DataTable
              headers={['Payment', 'Ledger', 'Payee', 'Amount', '', '']}
              rows={w.drafts.map((r) => [
                <RowLink key="rq" href={`/money/payments/${r.id}/requisition`}>{`#${String(r.id)}`}</RowLink>,
                String(r.ledger_number),
                payeeOf(r),
                Number(r.amount).toFixed(2),
                <InlineAction key="sb" action={submitPaymentAction} fields={{ payment: r.id as number }} label="Submit" />,
                <InlineAction key="cx" action={cancelPaymentAction} fields={{ payment: r.id as number }} label="Cancel" />,
              ])}
              emptyState="No drafts."
            />
          </Panel>
        </div>
        <div>
          <Panel title="Draft a payment">
            <form method="get" className="max-w-md">
              <MatterPicker
                name="ledger_q"
                mode="text"
                label="Ledger, matter, old file number or client name"
                hint="Suggestions appear as you type — pick one, or press Find on a typed number"
                placeholder="e.g. 2026-0415, M-2026-00582 or Smith"
                initialText={ledgerQ}
              />
              <SubmitButton>Find</SubmitButton>
            </form>
            {ledgerQ && matches.length === 0 ? (
              <p className="text-sm text-red-700 mt-2">No client ledger answers to “{ledgerQ}”. Check the number on the matter's money tab.</p>
            ) : null}
            {matches.length > 1 && !chosen ? (
              <DataTable
                headers={['Ledger', 'Matter', 'Client', 'Account', 'Available', '']}
                rows={matches.map((m) => [
                  m.ledgerNumber,
                  `${m.matterNumber} ${m.matterTitle}`,
                  m.clientName,
                  m.accountName,
                  m.available.toFixed(2),
                  <RowLink key="u" href={`/money/payments?ledger_q=${encodeURIComponent(m.ledgerNumber)}`}>Use this ledger</RowLink>,
                ])}
                emptyState=""
              />
            ) : null}
            {chosen ? (
              <div className="mt-3">
                <div className="rounded border p-3 text-sm mb-3">
                  <div><strong>{chosen.matterNumber}</strong> — {chosen.matterTitle}</div>
                  <div>Client: {chosen.clientName || '—'} · Ledger <strong>{chosen.ledgerNumber}</strong> ({chosen.accountName}) · {chosen.status}</div>
                  <div className="mt-1">
                    Held <strong>{chosen.balance.toFixed(2)}</strong> · earmarked {chosen.earmarked.toFixed(2)} ·{' '}
                    <strong>available to pay {chosen.available.toFixed(2)}</strong>
                  </div>
                  {chosen.status !== 'open' ? <div className="text-red-700 mt-1">This ledger is {chosen.status} — payments draft against open ledgers only.</div> : null}
                </div>
                <form action={draftPaymentAction} className="max-w-md">
                  <input type="hidden" name="matter_ledger" value={chosen.id} />
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Amount" hint={`Available ${chosen.available.toFixed(2)}`}>
                      <TextInput name="amount" required inputMode="decimal" />
                    </Field>
                    <Field label="Method">
                      <TextInput name="method" defaultValue="electronic_transfer" required />
                    </Field>
                  </div>
                  <Field label="Payee (name as it appears at the bank)">
                    <TextInput name="payee_description" required />
                  </Field>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Payee account name">
                      <TextInput name="payee_account_name" />
                    </Field>
                    {payeeFields.map((f) => (
                      <Field key={f.key} label={f.label ?? f.key.replace(/_/g, ' ')}>
                        <TextInput name={`payee_id_${f.key}`} />
                      </Field>
                    ))}
                  </div>
                  <Field label="Purpose of payment (always recorded; printed on the requisition)">
                    <TextInput name="reason" required placeholder="e.g. Settlement funds to client" />
                  </Field>
                  <p className="text-xs text-gray-600 mb-2">
                    The bank's transaction reference is entered when the payment is executed (the "Execute" step), once the transfer has been made.
                  </p>
                  <SubmitButton>Draft</SubmitButton>
                </form>
              </div>
            ) : null}
          </Panel>
          <Panel title={`Executed, last 30 days (${w.recentExecuted.length})`}>
            <DataTable
              headers={['Number', 'Ledger', 'Payee', 'Amount']}
              rows={w.recentExecuted.map((r) => [
                <RowLink key="rq" href={`/money/payments/${r.id}/requisition`}>{String(r.payment_number)}</RowLink>,
                String(r.ledger_number),
                payeeOf(r),
                Number(r.amount).toFixed(2),
              ])}
              emptyState="None."
            />
          </Panel>
        </div>
      </div>

      <Panel title="Find a payment">
        <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="Search">
            <TextInput name="q" defaultValue={sp.q ?? ''} placeholder="payee, P-number, reason, matter…" />
          </Field>
          <Field label="From">
            <TextInput name="from" type="date" defaultValue={sp.from ?? ''} />
          </Field>
          <Field label="To">
            <TextInput name="to" type="date" defaultValue={sp.to ?? ''} />
          </Field>
          <SubmitButton>Search</SubmitButton>
        </form>
        <DataTable
          headers={['Number', 'State', 'Payee', 'Amount', 'Reason', 'Matter', 'Executed', '']}
          rows={history.map((r) => [
            r.paymentNumber ?? '—',
            <Badge key="s" tone={r.state === 'executed' ? 'green' : r.state === 'blocked' || r.state === 'rejected' ? 'red' : 'neutral'}>
              {r.state.replace(/_/g, ' ')}
            </Badge>,
            r.payee,
            <span key="a" className="tabular-nums">{r.amount.toFixed(2)}</span>,
            r.reason,
            `${r.matterNumber} — ${r.matterTitle}`,
            r.executedAt ? fmtDateTime(r.executedAt) : '—',
            <RowLink key="m" href={`/matters/${r.matter}/money`}>Open</RowLink>,
          ])}
          emptyState="No payments match — widen the search or the dates."
        />
      </Panel>
    </Page>
  )
}
