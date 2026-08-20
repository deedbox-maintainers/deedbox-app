// The payment requisition: one client-money payment as a printable document —
// who is paid, from which ledger, how much, why, who asked, who authorised,
// and (once executed) the bank's own reference. Print it, or print to PDF,
// from the browser; the record is the register, this is its paper face.

import { requirePrincipal } from '@/lib/auth'
import { paymentRequisition } from '@/lib/reads/money'
import { bankDetailsText, bankFieldLabel } from '@/lib/ops/outbound/presentation'
import { formatMoney } from '@/lib/format'
import { Page, fmtDateTime } from '@/components/ui'

function name(v: unknown): string {
  const n = (v ?? {}) as { given?: string; family?: string; display?: string }
  return n.display ?? [n.given, n.family].filter(Boolean).join(' ')
}

export default async function PaymentRequisitionPage({ params }: { params: Promise<{ id: string }> }) {
  const p = await requirePrincipal()
  const { id } = await params
  const paymentId = Number(id)
  const { payment: r, authorisations, regional } = await paymentRequisition(p, paymentId)
  const payer = (r.account_bank_identifiers ?? {}) as Record<string, string>
  const payerText = Object.entries(payer)
    .map(([k, v]) => `${bankFieldLabel(k)} ${v}`)
    .join(' · ')
  const state = String(r.state)
  const heading = state === 'executed' ? `Payment ${String(r.payment_number)}` : `Payment requisition #${String(r.id)}`
  const rows: [string, string][] = [
    ['Firm', String(r.firm_name ?? '')],
    ['Payment / EFT number', r.payment_number ? String(r.payment_number) : `Requisition #${String(r.id)} — the payment number is allocated when the payment executes`],
    ['Status', state.replace(/_/g, ' ')],
    ['Matter', `${String(r.matter_number)} — ${String(r.matter_title)}${r.prior_reference ? ` (old file ${String(r.prior_reference)})` : ''}`],
    ['Client', String(r.client_name || '—')],
    ['Ledger', `${String(r.ledger_number)} · balance now ${Number(r.ledger_balance).toFixed(2)}`],
    ['Paid from (the firm’s client account)', `${String(r.account_name)}${payerText ? ` · ${payerText}` : ' · — bank identifiers not recorded'}`],
    ['Payee', String(r.payee_name ?? r.payee_description ?? '—')],
    ['Payee bank details',
      bankDetailsText(r.payee_bank_details)
        || bankDetailsText(r.firm_payee_details)
        || '— (not recorded)'],
    ['Amount', formatMoney(r.amount, regional)],
    ['Method', String(r.method).replace(/_/g, ' ')],
    ['Purpose', String(r.purpose) === 'general' ? String(r.reason) : `${String(r.purpose).replace(/_/g, ' ')} — ${String(r.reason)}`],
    ['Requested by', `${name(r.requester_name)} · ${fmtDateTime(r.created_at)}`],
    ['Submitted', r.submitted_at ? fmtDateTime(r.submitted_at) : '—'],
    ['Authorised', authorisations.length
      ? authorisations.map((a) => `${a.decision === 'approved' ? 'Approved' : 'Rejected'} by ${name(a.person_name)} · ${fmtDateTime(a.decided_at)}`).join('; ')
      : '— (awaiting)'],
    ['Executed', r.executed_at ? fmtDateTime(r.executed_at) : '— (not yet paid)'],
    ['Bank transaction reference', String(r.external_reference ?? '— (entered at execution)')],
  ]
  return (
    <Page
      title={heading}
      lead="The register is the record; this is its paper face."
      actions={
        <a
          href={`/money/payments/${paymentId}/requisition/pdf`}
          className="rounded-md bg-[var(--brand-primary,#171717)] px-3 py-1.5 text-sm text-white hover:opacity-90 print:hidden"
        >
          Download PDF
        </a>
      }
    >
      <div className="max-w-2xl rounded border bg-white p-6 print:border-0 print:p-0">
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-b align-top last:border-0">
                <th className="w-52 py-2 pr-4 text-left font-medium text-gray-600">{k}</th>
                <td className="py-2">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-8 grid grid-cols-2 gap-8 text-sm print:mt-12">
          <div>
            <div className="border-t pt-2">Prepared / requested — signature &amp; date</div>
          </div>
          <div>
            <div className="border-t pt-2">Authorised — signature &amp; date</div>
          </div>
        </div>
      </div>
      <p className="mt-3 text-xs text-gray-600 print:hidden">
        Download PDF (above) saves the requisition for the file — print it from there. Once the transfer is made, execute the
        payment on the payments screen and enter the bank's transaction reference — it is then printed here.
      </p>
    </Page>
  )
}
