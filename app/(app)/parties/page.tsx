// Party list / picker: search-as-you-type over the match keys (every
// name of every kind, folded and phonetic, plus phone/email keys). Merged
// and soft-deleted parties never appear.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { partyList } from '@/lib/reads/matters'
import { Page, Panel, DataTable, Notices, RowLink, Badge } from '@/components/ui'
import { TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'

export default async function PartiesPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const q = sp.q ?? ''
  const rows = await partyList(p, { q })
  return (
    <Page
      title="People & organisations"
      lead="Everyone the firm deals with — clients, other parties, related people. Searching covers every name a party has ever had."
      actions={
        <Link
          href="/parties/new"
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
        >
          New party
        </Link>
      }
    >
      <Notices searchParams={sp} />
      <Panel>
        <form method="get" className="mb-4 flex max-w-md items-center gap-2">
          <TextInput name="q" defaultValue={q} placeholder="Search names, phone, email…" />
          <SubmitButton tone="quiet">Search</SubmitButton>
        </form>
        <DataTable
          headers={['Name', 'Kind', 'Phone', 'Email', 'Matched on']}
          rows={rows.map((r) => [
            <RowLink key="n" href={`/parties/${r.id}`}>
              {r.displayName}
            </RowLink>,
            <Badge key="k">{r.kind}</Badge>,
            r.primaryPhone ?? '—',
            r.primaryEmail ?? '—',
            r.matchedName && r.matchedName !== r.displayName ? (
              <span key="m" className="text-neutral-500">
                {r.matchedName}
              </span>
            ) : (
              ''
            ),
          ])}
          emptyState={
            q
              ? 'No people or organisations match that search.'
              : 'No people or organisations yet — create the first.'
          }
        />
      </Panel>
    </Page>
  )
}
