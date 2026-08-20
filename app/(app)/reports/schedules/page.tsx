// Schedule manager: next run, recipients, format, paused reasons;
// every recipient's copy is that person's own predicate-bound run.

import { requirePrincipal } from '@/lib/auth'
import { scheduleManager } from '@/lib/reads/operations'
import { Page, Panel, DataTable, EmptyState, Notices, Badge, fmtDateTime, personName } from '@/components/ui'
import { SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { pauseScheduleAction } from '../actions'

export default async function SchedulesPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const d = await scheduleManager(p)

  return (
    <Page
      title="Report schedules"
      lead="Each recipient's scheduled copy equals that person running the report themselves at the same instant — restricted matters can never travel to someone without sight of them."
    >
      <Notices searchParams={sp} />
      <Panel title={`${d.schedules.length} schedule(s)`}>
        {d.schedules.length === 0 ? (
          <EmptyState>No schedules — any report can be emailed on a cycle you choose.</EmptyState>
        ) : (
          <DataTable
            headers={['Report', 'Owner', 'Cycle', 'Format', 'Recipients', 'Next run', 'State', '']}
            rows={d.schedules.map((s) => [
              String(s.report_name ?? `${s.report_kind} #${s.report}`),
              personName(s.owner_name),
              String((s.period as { every?: string })?.every ?? '—'),
              String(s.format),
              String(s.recipients),
              s.next_run_at ? fmtDateTime(s.next_run_at) : '—',
              s.active ? (
                <Badge key="s" tone="green">active</Badge>
              ) : (
                <span key="s">
                  <Badge tone="neutral">paused</Badge>{' '}
                  <span className="text-xs text-neutral-500">{String(s.paused_reason ?? '')}</span>
                </span>
              ),
              <form key="p" action={pauseScheduleAction}>
                <input type="hidden" name="schedule" value={String(s.id)} />
                <input type="hidden" name="paused" value={String(Boolean(s.active))} />
                <input type="hidden" name="reason" value="paused from the manager" />
                <SubmitButton>{s.active ? 'Pause' : 'Resume'}</SubmitButton>
              </form>,
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
