// Conflict register: all past checks — when, who, terms, attachment,
// resolution state; each opens its immutable snapshot.

import { requirePrincipal } from '@/lib/auth'
import { conflictRegister } from '@/lib/reads/matters'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { readParams, type SearchParams } from '@/lib/screens/action'

export default async function ConflictRegisterPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await conflictRegister(p, { limit: 500 })
  return (
    <Page
      title="Conflict register"
      lead="Every check ever run. Snapshots are immutable — a check renders exactly as it did the day it ran, whatever has merged or changed since."
    >
      <Notices searchParams={sp} />
      <Panel>
        <DataTable
          headers={['Check', 'Searched', 'By', 'When', 'Attached to', 'Resolution']}
          rows={rows.map((c) => [
            <RowLink key="c" href={`/conflicts/${c.id}`}>
              #{c.id}
            </RowLink>,
            c.terms?.name ?? '—',
            c.runnerName,
            fmtDateTime(c.runAt),
            c.attachedToKind === 'none' ? (
              '—'
            ) : c.attachedToKind === 'matter' ? (
              <RowLink key="a" href={`/matters/${c.attachedTo}`}>
                {c.attachedMatterNumber ?? `matter #${c.attachedTo}`}
              </RowLink>
            ) : (
              <RowLink key="a" href={`/intake/${c.attachedTo}`}>
                approach #{c.attachedTo}
              </RowLink>
            ),
            c.resolution ? (
              <Badge key="r" tone={c.resolution === 'no_conflict_found' ? 'green' : 'amber'}>
                {c.resolution.replace(/_/g, ' ')}
              </Badge>
            ) : (
              'unresolved'
            ),
          ])}
          emptyState="No checks yet."
        />
      </Panel>
    </Page>
  )
}
