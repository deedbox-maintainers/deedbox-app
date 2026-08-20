// One reconciliation: match groups, their members, and the typed
// exceptions with lineage state. A member whose counterpart sits outside
// the examined period says so honestly.

import { requirePrincipal } from '@/lib/auth'
import { examinerRecon } from '@/lib/reads/examiner'
import { Page, Panel, DataTable, EmptyState, Badge, DetailList, fmtDate, fmtDateTime, fmtJson } from '@/components/ui'

export default async function ExaminerReconPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const d = await examinerRecon(p, Number(id))
  const r = d.recon

  return (
    <Page
      title={`Reconciliation — ${String(r.account_name)}, statement ${fmtDate(r.statement_date)}`}
      lead={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={r.status === 'certified' ? 'green' : 'amber'}>
            {String(r.status).replace(/_/g, ' ')}
          </Badge>
          {r.certified_at ? <span>certified {fmtDateTime(r.certified_at)}</span> : null}
        </span>
      }
    >
      <Panel title="The certified equation">
        {r.equation_snapshot ? (
          <pre className="overflow-x-auto rounded bg-neutral-50 p-3 text-xs text-neutral-700">
            {fmtJson(r.equation_snapshot)}
          </pre>
        ) : (
          <EmptyState>Not yet certified — no equation snapshot exists.</EmptyState>
        )}
        <DetailList
          items={[
            ['Statement balance', <span key="b" className="tabular-nums">{Number(r.statement_balance).toFixed(2)}</span>],
          ]}
        />
      </Panel>
      <Panel title="Match groups">
        {d.members.length === 0 ? (
          <EmptyState>No match groups.</EmptyState>
        ) : (
          <DataTable
            headers={['Group', 'Side', 'Date', 'Amount', 'Description / kind']}
            rows={d.members.map((m) => [
              String(m.match_group),
              String(m.member_kind).replace(/_/g, ' '),
              m.member_kind === 'statement_line'
                ? fmtDate(m.line_date)
                : m.txn
                  ? fmtDate(m.effective_date)
                  : '—',
              <span key="a" className="tabular-nums">
                {m.member_kind === 'statement_line'
                  ? Number(m.line_amount).toFixed(2)
                  : m.txn
                    ? '—'
                    : ''}
              </span>,
              m.member_kind === 'statement_line'
                ? String(m.description ?? '')
                : m.txn
                  ? String(m.txn_kind).replace(/_/g, ' ')
                  : 'outside the examined period',
            ])}
          />
        )}
      </Panel>
      <Panel title="Exceptions">
        {d.exceptions.length === 0 ? (
          <EmptyState>No exceptions on this reconciliation.</EmptyState>
        ) : (
          <DataTable
            headers={['Type', 'Amount', 'Arising', 'State', 'Resolution note']}
            rows={d.exceptions.map((e) => [
              String(e.exception_type).replace(/_/g, ' '),
              <span key="a" className="tabular-nums">{Number(e.amount).toFixed(2)}</span>,
              fmtDate(e.arising_date),
              <Badge
                key="s"
                tone={e.state === 'resolved' ? 'green' : e.state === 'open' ? 'amber' : 'neutral'}
              >
                {String(e.state).replace(/_/g, ' ')}
              </Badge>,
              e.resolution_note ? String(e.resolution_note) : '—',
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
