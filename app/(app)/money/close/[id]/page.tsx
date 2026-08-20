// A close's workspace: the live balance listing preview, then certification
// — the schema writes the every-ledger listing itself, proves it totals the
// bank position, and locks the period on the posting path.

import { requirePrincipal } from '@/lib/auth'
import { closePreview } from '@/lib/reads/money'
import { Page, Panel, DataTable, DetailList, Notices, Badge, fmtDate, fmtDateTime } from '@/components/ui'
import { InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { certifyCloseAction } from '../../actions'

export default async function CloseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const d = await closePreview(p, Number(id))
  const c = d.close

  return (
    <Page
      title={`Close — ${fmtDate(c.period_start)} to ${fmtDate(c.period_end)}`}
      lead={`${c.account ? String(c.account_name) : 'All accounts'} · ${String(c.status).replace('_', ' ')}${c.late ? ' · CERTIFIED LATE (permanent)' : ''}`}
    >
      <Notices searchParams={sp} />

      <Panel
        title={c.status === 'certified' ? 'The certified balance listing' : 'Live balance listing (preview)'}
        actions={
          c.status === 'in_progress' ? (
            <InlineAction
              action={certifyCloseAction}
              fields={{ close: c.id as number }}
              label="Certify — the schema proves the listing totals the bank position"
              tone="danger"
            />
          ) : undefined
        }
      >
        {c.status === 'certified' ? (
          <>
            <DetailList
              items={[
                ['Certified', fmtDateTime(c.certified_at)],
                ['Late', c.late ? 'yes — the flag never clears' : 'no'],
              ]}
            />
            <DataTable
              headers={['Ledger', 'Balance']}
              rows={d.certifiedListing.map((l) => [
                String(l.ledger_number),
                Number(l.balance).toFixed(2),
              ])}
            />
          </>
        ) : (
          <>
            <DataTable
              headers={['Ledger', 'Kind', 'Matter', 'Balance now']}
              rows={d.liveLedgers.map((l) => [
                String(l.ledger_number),
                String(l.ledger_kind).replace(/_/g, ' '),
                l.matter_number ? String(l.matter_number) : <Badge tone="violet">firm-level</Badge>,
                Number(l.balance).toFixed(2),
              ])}
            />
            <p className="mt-2 text-sm text-neutral-600">
              Live total: <strong className="tabular-nums">{d.liveTotal.toFixed(2)}</strong> — the
              certification refuses unless the listing it writes totals the bank position
              (the period-end certified reconciliation).
            </p>
          </>
        )}
      </Panel>
    </Page>
  )
}
