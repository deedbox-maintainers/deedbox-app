// Batch detail: per-record dispositions, the machine-readable report
// artefact, and the all-or-nothing reversal with its blockers named.

import { requirePrincipal } from '@/lib/auth'
import { importBatchDetail } from '@/lib/reads/operations'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink, Badge, fmtDateTime, fmtJson } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { reverseBatchAction } from '../actions'

const DISPO_TONES: Record<string, 'green' | 'amber' | 'red' | 'blue'> = {
  accepted: 'green',
  accepted_with_warning: 'amber',
  refused: 'red',
  updated: 'blue',
}

export default async function ImportBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const d = await importBatchDetail(p, Number(id))
  const b = d.batch

  return (
    <Page
      title={`Import batch #${String(b.id)}`}
      lead={
        <span className="flex flex-wrap items-center gap-2">
          <span>
            {String(b.record_domain).replace(/_/g, ' ')} · {String(b.mode).replace(/_/g, ' ')} ·{' '}
            {String(b.source_system)} · started {fmtDateTime(b.started_at)}
          </span>
          <Badge tone={b.state === 'completed' ? 'green' : b.state === 'refused' ? 'red' : 'neutral'}>
            {String(b.state).replace(/_/g, ' ')}
          </Badge>
          <RowLink href="/imports">All batches</RowLink>
        </span>
      }
    >
      <Notices searchParams={sp} />
      <Panel title="Counts">
        <pre className="overflow-x-auto rounded bg-neutral-50 p-3 text-xs text-neutral-700">
          {fmtJson(b.counts)}
        </pre>
        {b.report_artefact ? (
          <p className="text-xs text-neutral-500">
            Machine-readable report: artefact #{String(b.report_artefact)}
          </p>
        ) : null}
      </Panel>
      <Panel title={`Per-record dispositions (${d.records.length})`}>
        {d.records.length === 0 ? (
          <EmptyState>No record rows.</EmptyState>
        ) : (
          <DataTable
            headers={['Source ref', 'Disposition', 'Message', 'Target']}
            rows={d.records.map((r) => [
              String(r.source_ref),
              <Badge key="d" tone={DISPO_TONES[String(r.disposition)] ?? 'blue'}>
                {String(r.disposition).replace(/_/g, ' ')}
              </Badge>,
              r.message ? String(r.message) : '—',
              r.target_type ? `${String(r.target_type)} #${String(r.target)}` : '—',
            ])}
          />
        )}
      </Panel>
      {b.state === 'completed' && b.mode === 'real' ? (
        <Panel title="Reverse this batch">
          <p className="mb-2 text-sm text-neutral-600">
            All-or-nothing: one record touched by anyone since import blocks the whole reversal,
            and the blockers are named by source reference. Money unwinds as proper reversal
            documents; nothing is deleted.
          </p>
          <form action={reverseBatchAction} className="flex items-end gap-2">
            <input type="hidden" name="batch" value={String(b.id)} />
            <Field label="Reason">
              <TextInput name="reason" />
            </Field>
            <SubmitButton>Reverse the batch</SubmitButton>
          </form>
        </Panel>
      ) : null}
    </Page>
  )
}
