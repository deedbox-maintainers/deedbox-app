// My tasks queue: open tasks by due date, overdue flagged, filters,
// complete/reassign in place.

import { requirePrincipal } from '@/lib/auth'
import { myTasksQueue } from '@/lib/reads/experience'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink, Badge, fmtDate, personName } from '@/components/ui'
import { Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { taskDoneAction, reassignTaskAction } from './actions'

export default async function TasksPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const d = await myTasksQueue(p, {
    matter: sp.matter ? Number(sp.matter) : undefined,
    origin: sp.origin || undefined,
  })

  return (
    <Page title="My tasks" lead="Open tasks in due-date order. Completing a task on a closed matter needs the closed-edit permission, like any other change.">
      <Notices searchParams={sp} />
      <Panel title={`${d.tasks.length} open`}>
        {d.tasks.length === 0 ? (
          <EmptyState>Nothing due — well done.</EmptyState>
        ) : (
          <DataTable
            headers={['Task', 'Matter', 'Stage', 'Origin', 'Due', 'Complete', 'Reassign']}
            rows={d.tasks.map((t) => [
              String(t.title),
              t.matter ? (
                <RowLink key="m" href={`/matters/${t.matter}/workflow`}>
                  {String(t.matter_number)}
                </RowLink>
              ) : (
                '—'
              ),
              t.stage_name ? String(t.stage_name) : '—',
              String(t.origin),
              t.due_date ? (
                <span key="d">
                  {fmtDate(t.due_date)} {t.overdue ? <Badge tone="red">overdue</Badge> : null}
                </span>
              ) : (
                'awaiting date'
              ),
              <form key="c" action={taskDoneAction}>
                <input type="hidden" name="task" value={String(t.id)} />
                <input type="hidden" name="done" value="true" />
                <input type="hidden" name="back" value="/tasks" />
                <SubmitButton>Done</SubmitButton>
              </form>,
              <form key="r" action={reassignTaskAction} className="flex items-center gap-1">
                <input type="hidden" name="task" value={String(t.id)} />
                <input type="hidden" name="back" value="/tasks" />
                <Select name="owner">
                  {d.staff.map((s) => (
                    <option key={String(s.id)} value={String(s.id)}>
                      {personName(s.person_name)}
                    </option>
                  ))}
                </Select>
                <SubmitButton>Go</SubmitButton>
              </form>,
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
