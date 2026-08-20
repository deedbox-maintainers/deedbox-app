// Merge screen: pick the duplicate to absorb, see the honest dry-run
// diff (every repoint enumerated from the manifests, collisions, restricted
// involvement), then commit. The undo banner lives on the survivor's profile
// for the window.

import { requirePrincipal } from '@/lib/auth'
import { dryRunMerge } from '@/lib/ops/matters'
import { partyList } from '@/lib/reads/matters'
import { Page, Panel, DataTable, DetailList, Notices, RowLink, Badge } from '@/components/ui'
import { TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { commitMergeAction } from '../../actions'

export default async function MergePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const survivor = Number(id)
  const sp = await readParams(searchParams)
  const q = sp.q ?? ''
  const absorbed = sp.absorbed ? Number(sp.absorbed) : null

  const candidates = q ? (await partyList(p, { q })).filter((r) => r.id !== survivor) : []
  const dryRun = absorbed ? await dryRunMerge(p, { survivor, absorbed }) : null

  return (
    <Page
      title="Merge duplicate"
      lead="Everything on the duplicate — matters, links, bills, money records — is re-pointed at the surviving record. History snapshots stay exactly as written; searches for the old name keep finding the survivor."
    >
      <Notices searchParams={sp} />

      {!dryRun ? (
        <Panel title="1. Find the duplicate to absorb">
          <form method="get" className="mb-4 flex max-w-md items-center gap-2">
            <TextInput name="q" defaultValue={q} placeholder="Search for the duplicate…" />
            <SubmitButton tone="quiet">Search</SubmitButton>
          </form>
          <DataTable
            headers={['Name', 'Phone', 'Email', '']}
            rows={candidates.map((c) => [
              c.displayName,
              c.primaryPhone ?? '—',
              c.primaryEmail ?? '—',
              <RowLink key="pick" href={`/parties/${survivor}/merge?absorbed=${c.id}`}>
                Preview merge
              </RowLink>,
            ])}
            emptyState={q ? 'Nothing matches.' : 'Search for the duplicate record above.'}
          />
        </Panel>
      ) : (
        <>
          <Panel title="2. What this merge will do — nothing has happened yet">
            <DetailList
              items={[
                ['Survivor (kept)', <RowLink key="s" href={`/parties/${dryRun.survivor.id}`}>{dryRun.survivor.displayName}</RowLink>],
                ['Absorbed (merged away)', dryRun.absorbed.displayName],
                [
                  'Rows re-pointed',
                  dryRun.repoints.length === 0
                    ? 'None — the duplicate is not referenced anywhere live'
                    : '',
                ],
              ]}
            />
            {dryRun.repoints.length > 0 ? (
              <div className="mt-3">
                <DataTable
                  headers={['Where', 'Rows']}
                  rows={dryRun.repoints.map((r) => [r.table.replace(/_/g, ' '), String(r.rows)])}
                />
              </div>
            ) : null}
            {dryRun.collisions.length > 0 ? (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <p className="mb-1 font-medium">Overlaps that will collapse into one row:</p>
                <ul className="list-inside list-disc">
                  {dryRun.collisions.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {dryRun.restrictedMattersInvolved > 0 ? (
              <p className="mt-3 text-sm">
                <Badge tone="amber">
                  {dryRun.restrictedMattersInvolved} restricted matter(s) involved
                </Badge>{' '}
                — the merge proceeds as a privileged registered event.
              </p>
            ) : null}
          </Panel>
          <Panel title="3. Commit">
            <p className="mb-3 text-sm text-neutral-500">
              The merge is one all-or-nothing act, recorded in the register with the full
              before/after. Undo stays available for the firm’s window unless something it moved is
              later touched.
            </p>
            <form action={commitMergeAction}>
              <input type="hidden" name="survivor" value={survivor} />
              <input type="hidden" name="absorbed" value={dryRun.absorbed.id} />
              {/* the operation verifies the world still matches THIS dry-run */}
              <input type="hidden" name="dry_run" value={JSON.stringify(dryRun)} />
              <SubmitButton tone="danger">Merge “{dryRun.absorbed.displayName}” into “{dryRun.survivor.displayName}”</SubmitButton>
            </form>
          </Panel>
        </>
      )}
    </Page>
  )
}
