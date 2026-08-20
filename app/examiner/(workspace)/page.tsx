// Examiner home: the accounts with their in-period cash-book movement, the
// one-action examination pack export, and the exports already taken. The
// empty state names the access window.

import { requirePrincipal } from '@/lib/auth'
import { examinerContext, examinerHome } from '@/lib/reads/examiner'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink, Badge, fmtDate, fmtDateTime } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { exportPackAction } from './actions'

export default async function ExaminerHomePage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const ctx = await examinerContext(p)
  const d = await examinerHome(p)

  return (
    <Page
      title="Examination workspace"
      lead={`Your access window runs from ${fmtDateTime(ctx.startsAt)} to ${fmtDateTime(ctx.expiresAt)}; the examined period is ${fmtDate(ctx.periodStart)} to ${fmtDate(ctx.periodEnd)}. Everything here is read-only and every read is recorded.`}
    >
      <Notices searchParams={sp} />
      <Panel title="Client accounts — cash books">
        {d.accounts.length === 0 ? (
          <EmptyState>
            Your access window runs from {fmtDateTime(ctx.startsAt)} to{' '}
            {fmtDateTime(ctx.expiresAt)}; select a period to begin.
          </EmptyState>
        ) : (
          <DataTable
            headers={['Account', 'Kind', 'Movements in period', 'Net movement', '']}
            rows={d.accounts.map((a) => [
              <span key="n">
                {String(a.name)} {!a.active ? <Badge tone="neutral">deactivated</Badge> : null}
              </span>,
              String(a.account_kind).replace(/_/g, ' '),
              <span key="c" className="tabular-nums">{String(a.period_lines)}</span>,
              <span key="s" className="tabular-nums">{Number(a.period_net).toFixed(2)}</span>,
              <RowLink key="l" href={`/examiner/cash-book/${a.id}`}>
                Open cash book
              </RowLink>,
            ])}
          />
        )}
      </Panel>
      <Panel title="Examination pack export">
        <p className="mb-3 text-sm text-neutral-600">
          One action assembles every money movement in the requested period, grouped per ledger
          under the minimal header, stores the exact artefact and records the export.
        </p>
        <form action={exportPackAction} className="flex flex-wrap items-end gap-3">
          <Field label="Period start">
            <TextInput name="period_start" type="date" defaultValue={ctx.periodStart} />
          </Field>
          <Field label="Period end">
            <TextInput name="period_end" type="date" defaultValue={ctx.periodEnd} />
          </Field>
          <SubmitButton>Export the pack</SubmitButton>
        </form>
        {d.exports.length > 0 ? (
          <div className="mt-4">
            <DataTable
              headers={['Exported at', 'Period', 'Stored artefact']}
              rows={d.exports.map((e) => [
                fmtDateTime(e.exported_at),
                `${fmtDate((e.period as { start?: string })?.start)} – ${fmtDate((e.period as { end?: string })?.end)}`,
                `#${String(e.artefact)}`,
              ])}
            />
          </div>
        ) : null}
      </Panel>
    </Page>
  )
}
