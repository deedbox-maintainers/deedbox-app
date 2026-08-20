// Cash book: one account's cash-book lines within the examined
// period, in the books' own order.

import { requirePrincipal } from '@/lib/auth'
import { examinerCashBook } from '@/lib/reads/examiner'
import { Page, Panel, DataTable, EmptyState, fmtDate } from '@/components/ui'

export default async function ExaminerCashBookPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const d = await examinerCashBook(p, Number(id))

  return (
    <Page
      title={`Cash book — ${String(d.account.name)}`}
      lead="Account-side movements within the examined period. Figures are the books' own."
    >
      <Panel title="Movements">
        {d.lines.length === 0 ? (
          <EmptyState>No cash-book movement in the examined period.</EmptyState>
        ) : (
          <DataTable
            headers={['Date', 'Kind', 'Amount', 'Reason']}
            rows={d.lines.map((l) => [
              fmtDate(l.effective_date),
              String(l.txn_kind).replace(/_/g, ' '),
              <span key="a" className="tabular-nums">{Number(l.signed_amount).toFixed(2)}</span>,
              l.reason ? String(l.reason) : '—',
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
