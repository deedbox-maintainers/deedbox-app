// The multi-select confirmation: the dry-run rendered item by item, then a
// commit of EXACTLY this dry-run — the machinery re-verifies every item's
// before-state at commit and refuses re-preparation on any mismatch, so what
// you saw is what happens, or nothing does.

import { requirePrincipal } from '@/lib/auth'
import { dryRunBulk, type BulkMatterKind } from '@/lib/ops/bulk'
import { Page, Panel, DataTable, Notices, RowLink, Badge } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { bulkCommitAction } from '../actions'

const KIND_LABELS: Record<string, string> = {
  matter_close: 'Close',
  matter_reopen: 'Reopen',
  matter_hold: 'Put on hold',
  matter_resume: 'Resume',
}

export default async function BulkConfirmPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const kind = sp.kind as BulkMatterKind
  const matters = (sp.matters ?? '')
    .split(',')
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0)
  const dryRun = await dryRunBulk(p, { kind, matters })
  const needsReason = kind === 'matter_reopen'

  return (
    <Page
      title={`${KIND_LABELS[kind] ?? kind} ${matters.length} matter(s) — confirm`}
      lead="Nothing has happened yet. Items that would refuse are listed with the reason and simply skipped; the rest change together in one recorded act, reversible for the firm's window."
    >
      <Notices searchParams={sp} />
      <Panel title={`Dry run: ${dryRun.included} will proceed, ${dryRun.skipped} will skip`}>
        <DataTable
          headers={['Matter', 'Now', 'Becomes', 'Or skips because']}
          rows={dryRun.items.map((i) => [
            i.matterNumber ? (
              <RowLink key="m" href={`/matters/${i.matter}`}>
                {i.matterNumber}
              </RowLink>
            ) : (
              `#${i.matter}`
            ),
            i.before?.status?.replace('_', ' ') ?? '—',
            i.after ? (
              <Badge key="a" tone="green">{i.after.status.replace('_', ' ')}</Badge>
            ) : (
              '—'
            ),
            i.willSkip ?? '',
          ])}
        />
      </Panel>
      {dryRun.included > 0 ? (
        <Panel title="Commit">
          <form action={bulkCommitAction} className="max-w-md">
            <input type="hidden" name="dry_run" value={JSON.stringify(dryRun)} />
            {needsReason ? (
              <Field label="Reason (reopening always carries one)">
                <TextInput name="reason" required />
              </Field>
            ) : null}
            <SubmitButton tone="danger">
              {KIND_LABELS[kind]} {dryRun.included} matter(s)
            </SubmitButton>
          </form>
        </Panel>
      ) : (
        <Panel>
          <p className="text-sm text-neutral-500">
            Every selected matter would skip — there is nothing to commit.{' '}
            <RowLink href="/matters">Back to the list</RowLink>.
          </p>
        </Panel>
      )}
    </Page>
  )
}
