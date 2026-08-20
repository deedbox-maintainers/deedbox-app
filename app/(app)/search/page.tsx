// Search: the full-results page with type filters and snippets; an empty
// query serves recents and pins. Names tolerate misspellings (the index
// carries folded and trigram keys); restricted matters are structurally
// absent (the predicate rides every query). This page is also the command
// palette's engine — jump by name or number from anywhere.

import { requirePrincipal } from '@/lib/auth'
import { search } from '@/lib/ops/reports'
import { homeScreen } from '@/lib/reads/experience'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink } from '@/components/ui'
import { TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'

const TYPES = ['', 'matter', 'party', 'note', 'task', 'key_date', 'time_entry']

function hitHref(t: string, source: number, matter: number | null): string {
  if (t === 'matter') return `/matters/${source}`
  if (t === 'party') return `/parties/${source}`
  if (matter) return `/matters/${matter}`
  return '/search'
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const q = (sp.q ?? '').trim()
  const entryType = sp.type || undefined
  const hits = q.length >= 2 ? (await search(p, { query: q, entryType })).hits : null
  const home = hits === null ? await homeScreen(p) : null

  return (
    <Page title="Search" lead="Everything you can see, one box — matters, people, notes, tasks, key dates, time.">
      <Notices searchParams={sp} />
      <Panel>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <TextInput name="q" defaultValue={q} autoFocus />
          <select name="type" defaultValue={sp.type ?? ''} className="rounded border border-neutral-300 px-2 py-1 text-sm">
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t === '' ? 'every type' : t.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <SubmitButton>Search</SubmitButton>
        </form>
      </Panel>
      {hits === null ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Panel title="Pinned">
            {home!.pins.length === 0 ? (
              <EmptyState>Pin matters you use often; your recent items will appear here.</EmptyState>
            ) : (
              <ul className="space-y-1 text-sm">
                {home!.pins.map((x) => (
                  <li key={`${x.item_type}-${x.item}`}>
                    <RowLink href={x.item_type === 'matter' ? `/matters/${x.item}` : `/parties/${x.item}`}>
                      {String(x.title)}
                    </RowLink>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Recent">
            {home!.recents.length === 0 ? (
              <EmptyState>Your recent items will appear here.</EmptyState>
            ) : (
              <ul className="space-y-1 text-sm">
                {home!.recents.map((x) => (
                  <li key={`${x.item_type}-${x.item}`}>
                    <RowLink href={x.item_type === 'matter' ? `/matters/${x.item}` : `/parties/${x.item}`}>
                      {String(x.title)}
                    </RowLink>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      ) : (
        <Panel title={`${hits.length} result(s)`}>
          {hits.length === 0 ? (
            <EmptyState>No matches — try fewer letters; names tolerate misspellings.</EmptyState>
          ) : (
            <DataTable
              headers={['Type', 'Title', 'Snippet', '']}
              rows={hits.map((h) => [
                h.entryType.replace(/_/g, ' '),
                String(h.title),
                <span key="s" className="text-xs text-neutral-500">{String(h.snippet)}</span>,
                <RowLink key="o" href={hitHref(h.entryType, h.source, h.matter)}>
                  Open
                </RowLink>,
              ])}
            />
          )}
        </Panel>
      )}
    </Page>
  )
}
