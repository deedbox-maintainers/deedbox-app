// One ledger: in-period lines in entry order with the running
// balances the line guard assigned — never recomputed here.

import { requirePrincipal } from '@/lib/auth'
import { examinerLedger } from '@/lib/reads/examiner'
import { Page, Panel, DataTable, EmptyState, Badge, fmtDate } from '@/components/ui'

export default async function ExaminerLedgerPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const d = await examinerLedger(p, Number(id))
  const h = d.header

  return (
    <Page
      title={`Ledger ${h ? String(h.ledger_number) : ''}`}
      lead={
        <span className="flex flex-wrap items-center gap-2">
          {h?.client_display_name ? <span>{String(h.client_display_name)}</span> : null}
          {h?.matter_reference ? <span>{String(h.matter_reference)}</span> : null}
          {!h?.client_display_name ? (
            <Badge tone="violet">{String(d.ledger.ledger_kind).replace(/_/g, ' ')}</Badge>
          ) : null}
          <Badge tone={d.ledger.status === 'open' ? 'green' : 'neutral'}>
            {String(d.ledger.status)}
          </Badge>
        </span>
      }
    >
      <Panel title="Lines in the examined period">
        {d.lines.length === 0 ? (
          <EmptyState>No movement in the examined period.</EmptyState>
        ) : (
          <DataTable
            headers={['Entry', 'Date', 'Kind', 'Amount', 'Running balance', 'Reason']}
            rows={d.lines.map((l) => [
              String(l.entry_no),
              fmtDate(l.effective_date),
              String(l.txn_kind).replace(/_/g, ' '),
              <span key="a" className="tabular-nums">{Number(l.signed_amount).toFixed(2)}</span>,
              <span key="b" className="tabular-nums">{Number(l.running_balance).toFixed(2)}</span>,
              l.reason ? String(l.reason) : '—',
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
