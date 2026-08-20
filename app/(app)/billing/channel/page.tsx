// Channel payments panel: started and failed events distinctly styled
// until settled; settled rows link to their receipt on whichever side the
// seam routed them; surcharge shown as channel evidence, never in a receipt.

import { requirePrincipal } from '@/lib/auth'
import { channelPanel } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, Badge, fmtDateTime } from '@/components/ui'
import { readParams, type SearchParams } from '@/lib/screens/action'

export default async function ChannelPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await channelPanel(p)
  return (
    <Page
      title="Online payments"
      lead="What the payment channel reports. Started and failed events touch no figure anywhere; only settlement creates a receipt — on the office or client-money side as the routing rule directs."
    >
      <Notices searchParams={sp} />
      <Panel>
        <DataTable
          headers={['When', 'Channel', 'Reference', 'For', 'Amount', 'Surcharge', 'State', 'Receipt']}
          rows={rows.map((r) => [
            fmtDateTime(r.created_at),
            String(r.channel),
            String(r.reference_code),
            `${String(r.target_kind).replace('_', ' ')} #${String(r.target)}`,
            Number(r.amount).toFixed(2),
            Number(r.surcharge_amount) > 0 ? Number(r.surcharge_amount).toFixed(2) : '—',
            <Badge
              key="s"
              tone={r.state === 'settled' ? 'green' : r.state === 'failed' ? 'red' : 'amber'}
            >
              {String(r.state)}
            </Badge>,
            r.state === 'settled'
              ? `${String(r.resulting_receipt_type).replace('_', ' ')} #${String(r.resulting_receipt)}`
              : '—',
          ])}
          emptyState="No in-flight payments."
        />
      </Panel>
    </Page>
  )
}
