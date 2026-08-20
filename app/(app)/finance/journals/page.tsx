// Journal list.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { glJournals } from '@/lib/reads/gl'
import { Page, Panel, Badge, Notices, DataTable, RowLink, fmtDate } from '@/components/ui'
import { readParams, type SearchParams } from '@/lib/screens/action'

const TONE: Record<string, 'green' | 'amber' | 'neutral'> = {
  posted: 'green',
  draft: 'amber',
  reversed: 'neutral',
}

export default async function JournalsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const journals = await glJournals(p)
  return (
    <Page
      title="Journals"
      lead="Every accounting movement, numbered and permanent once posted."
      actions={
        <Link
          href="/finance/journals/new"
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
        >
          New manual journal
        </Link>
      }
    >
      <Notices searchParams={sp} />
      <Panel>
        <DataTable
          headers={['No', 'Date', 'Description', 'Source', 'Amount', 'Status']}
          rows={(journals as Record<string, unknown>[]).map((j) => [
            <RowLink key="n" href={`/finance/journals/${j.id}`}>
              {(j.journal_no as string) ?? `draft ${j.id}`}
            </RowLink>,
            fmtDate(j.journal_date),
            j.description as string,
            j.source_type as string,
            <span key="a" className="tabular-nums">{Number(j.amount).toFixed(2)}</span>,
            <Badge key="s" tone={TONE[j.status as string] ?? 'neutral'}>{j.status as string}</Badge>,
          ])}
          emptyState="No journals yet."
        />
      </Panel>
    </Page>
  )
}
