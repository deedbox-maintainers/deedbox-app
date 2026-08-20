// Outbound message log: every message the platform sent or queued, each
// opening its exact rendered copy; state only ever moves forward.

import { requirePrincipal } from '@/lib/auth'
import { outboundLog } from '@/lib/reads/operations'
import { Page, Panel, DataTable, EmptyState, Notices, Badge, fmtDateTime } from '@/components/ui'
import { readParams, type SearchParams } from '@/lib/screens/action'

export default async function OutboundPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const d = await outboundLog(p, { purpose: sp.purpose || undefined, state: sp.state || undefined })

  return (
    <Page
      title="Outbound messages"
      lead="The exact rendered copy exists before dispatch and is retrievable forever; a retry is a new row pointing at the one it retries."
    >
      <Notices searchParams={sp} />
      <Panel title={`${d.rows.length} message(s)`}>
        <form className="mb-3 flex flex-wrap items-end gap-2" method="get">
          <select name="purpose" defaultValue={sp.purpose ?? ''} className="rounded border border-neutral-300 px-2 py-1 text-sm">
            <option value="">any purpose</option>
            {d.purposes.map((x) => (
              <option key={x} value={x}>
                {x.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <select name="state" defaultValue={sp.state ?? ''} className="rounded border border-neutral-300 px-2 py-1 text-sm">
            <option value="">any state</option>
            <option value="queued">queued</option>
            <option value="sent">sent</option>
            <option value="failed">failed</option>
          </select>
          <button type="submit" className="rounded border border-neutral-300 px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-50">
            Filter
          </button>
        </form>
        {d.rows.length === 0 ? (
          <EmptyState>Nothing sent yet.</EmptyState>
        ) : (
          <DataTable
            headers={['Queued', 'Channel', 'Recipient', 'Purpose', 'State', 'Copy', 'Retry of']}
            rows={d.rows.map((m) => [
              fmtDateTime(m.queued_at),
              String(m.channel).replace(/_/g, ' '),
              String(m.recipient),
              String(m.purpose).replace(/_/g, ' '),
              m.state === 'sent' ? (
                <span key="s">
                  <Badge tone="green">sent</Badge>{' '}
                  <span className="text-xs text-neutral-500">{fmtDateTime(m.sent_at)}</span>
                </span>
              ) : m.state === 'failed' ? (
                <span key="s">
                  <Badge tone="red">failed</Badge>{' '}
                  <span className="text-xs text-neutral-500">{String(m.failed_reason ?? '')}</span>
                </span>
              ) : (
                <Badge key="s" tone="amber">queued</Badge>
              ),
              `artefact ${String(m.rendered_artefact)}`,
              m.retry_of ? `#${String(m.retry_of)}` : '—',
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
