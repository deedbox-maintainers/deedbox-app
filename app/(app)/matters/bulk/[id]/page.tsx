// A committed bulk run's report: every item's before/after, the undo window,
// and the reversal — newest-first through the same domain rules, touched
// items blocking individually with their outcomes recorded here.

import { requirePrincipal } from '@/lib/auth'
import { bulkRunReport } from '@/lib/reads/matters'
import { Page, Panel, DataTable, DetailList, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { bulkReverseAction } from '../../actions'

export default async function BulkRunReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const report = await bulkRunReport(p, Number(id))

  return (
    <Page
      title={`Bulk run #${report.run.id}`}
      lead={`${report.run.kind.replace(/_/g, ' ')} — committed ${report.run.committedAt ? '' : 'not yet'}`}
    >
      <Notices searchParams={sp} />
      <Panel title="Run">
        <DetailList
          items={[
            ['Kind', report.run.kind.replace(/_/g, ' ')],
            ['Committed', fmtDateTime(report.run.committedAt)],
            ['Reversible until', fmtDateTime(report.run.reversibleUntil)],
            [
              'State',
              report.run.reversedAt ? (
                <Badge tone="neutral">reversed {fmtDateTime(report.run.reversedAt)}</Badge>
              ) : report.run.stillReversible ? (
                <Badge tone="green">stands — undo open</Badge>
              ) : (
                <Badge tone="neutral">stands — window closed</Badge>
              ),
            ],
          ]}
        />
      </Panel>
      <Panel title="Items">
        <DataTable
          headers={['Matter', 'Before', 'After', 'Reversal outcome']}
          rows={report.items.map((i) => [
            i.matterNumber ? (
              <RowLink key="m" href={`/matters/${i.entity}`}>
                {i.matterNumber}
              </RowLink>
            ) : (
              `${i.entityType} #${i.entity}`
            ),
            JSON.stringify(i.before),
            JSON.stringify(i.after),
            i.reversalOutcome ? (
              <span key="o">
                <Badge tone={i.reversalOutcome === 'blocked' ? 'red' : 'green'}>
                  {i.reversalOutcome}
                </Badge>
                {i.blockReason ? <span className="ml-1 text-neutral-500">{i.blockReason}</span> : null}
              </span>
            ) : (
              '—'
            ),
          ])}
        />
      </Panel>
      {report.run.stillReversible ? (
        <Panel title="Undo the whole run">
          <p className="mb-3 text-sm text-neutral-500">
            Reversal replays each item's inverse, newest first, through the same rules as any other
            change. An item touched since the run blocks individually and is itemised above; the
            rest still reverse.
          </p>
          <form action={bulkReverseAction} className="flex max-w-md items-end gap-2">
            <input type="hidden" name="run" value={report.run.id} />
            <div className="grow">
              <Field label="Reason (always recorded)">
                <TextInput name="reason" required />
              </Field>
            </div>
            <div className="pb-3">
              <SubmitButton tone="danger">Reverse</SubmitButton>
            </div>
          </form>
        </Panel>
      ) : null}
    </Page>
  )
}
