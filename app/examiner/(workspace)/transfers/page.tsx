// The transfer journal: same-account and cross-account transfers in
// one unbroken number series — one gapless stream covers both shapes —
// each side under the minimal header.

import { requirePrincipal } from '@/lib/auth'
import { examinerTransfers } from '@/lib/reads/examiner'
import { Page, Panel, DataTable, EmptyState, fmtDate } from '@/components/ui'

function side(ledger: unknown, client: unknown, ref: unknown): string {
  const bits = [String(ledger ?? '')]
  if (client) bits.push(String(client))
  if (ref) bits.push(String(ref))
  return bits.filter(Boolean).join(' — ')
}

export default async function ExaminerTransfersPage() {
  const p = await requirePrincipal()
  const rows = await examinerTransfers(p)

  return (
    <Page
      title="Transfer journal"
      lead="Every transfer between ledgers in the examined period — same-account and cross-account — as one number series."
    >
      <Panel title="Transfers">
        {rows.length === 0 ? (
          <EmptyState>No transfers in the examined period.</EmptyState>
        ) : (
          <DataTable
            headers={['Number', 'Date', 'Amount', 'From', 'To', 'Reason']}
            rows={rows.map((t) => [
              String(t.transfer_number),
              fmtDate(t.effective_date),
              <span key="a" className="tabular-nums">{Number(t.amount).toFixed(2)}</span>,
              side(t.from_ledger, t.from_client, t.from_matter_ref),
              side(t.to_ledger, t.to_client, t.to_matter_ref),
              String(t.reason),
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
