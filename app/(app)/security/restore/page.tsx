// Deleted-records restore: soft-deleted rows by type with the days
// remaining in each restore window.

import { requirePrincipal } from '@/lib/auth'
import { deletedRecords } from '@/lib/reads/security'
import { Page, Panel, DataTable, Badge, Notices, fmtDateTime } from '@/components/ui'
import { InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { restoreRecord } from '../actions'

export default async function RestorePage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await deletedRecords(p)
  return (
    <Page
      title="Deleted records"
      lead="Soft-deleted records within their restore window. After the window closes a record stays excluded permanently."
    >
      <Notices searchParams={sp} />
      <Panel>
        <DataTable
          headers={['Type', 'Record', 'Deleted', 'Window', '']}
          emptyState="Nothing is awaiting restore."
          rows={rows.map((r) => [
            r.entityType.replaceAll('_', ' '),
            r.label || `#${r.id}`,
            fmtDateTime(r.deletedAt),
            r.daysRemaining > 0 ? (
              <Badge tone={r.daysRemaining <= 7 ? 'amber' : 'neutral'}>{r.daysRemaining} day(s) left</Badge>
            ) : (
              <Badge tone="red">closed</Badge>
            ),
            r.daysRemaining > 0 ? (
              <InlineAction
                action={restoreRecord}
                fields={{ entity_type: r.entityType, id: r.id }}
                label="Restore"
              />
            ) : null,
          ])}
        />
      </Panel>
    </Page>
  )
}
