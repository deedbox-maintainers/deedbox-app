// The matter's stages & tasks panel + key dates & anchors panel. The
// headline position beside the stages is the ONE cache-fed display, labelled
// as such — every figure of record lives on the matter's own screens. Anchor
// changes move nothing until their proposal is confirmed.

import { requirePrincipal } from '@/lib/auth'
import { matterWorkflowTab } from '@/lib/reads/experience'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink, Badge, fmtDate, fmtDateTime, personName } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  createTaskAction,
  taskDoneAction,
  deleteTaskAction,
  createKeyDateAction,
  keyDateDoneAction,
  keyDateCriticalAction,
  setAnchorAction,
  applyTemplateAction,
  enterStageAction,
  completeStageAction,
  reopenStageAction,
} from '../../../tasks/actions'

export default async function MatterWorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const d = await matterWorkflowTab(p, Number(id))
  const back = `/matters/${id}/workflow`
  const pending = d.pendingDateProposals.length + d.pendingSlotProposals.length

  return (
    <Page
      title={`${String(d.matter.matter_number)} — workflow`}
      lead={
        <span className="flex flex-wrap items-center gap-3">
          <RowLink href={`/matters/${id}`}>Back to the matter</RowLink>
          {d.position ? (
            <span className="text-xs text-neutral-500">
              Cached position (display only): unbilled {Number(d.position.unbilled_value).toFixed(2)} ·
              outstanding {Number(d.position.outstanding_value).toFixed(2)} · held available{' '}
              {Number(d.position.held_available).toFixed(2)}
            </span>
          ) : null}
        </span>
      }
    >
      <Notices searchParams={sp} />
      {pending > 0 ? (
        <Panel title="Awaiting confirmation">
          <p className="text-sm text-neutral-700">
            <RowLink href="/proposals">
              {pending} proposed change{pending === 1 ? '' : 's'} on this matter await confirmation
            </RowLink>{' '}
            — no date or owner has moved.
          </p>
        </Panel>
      ) : null}
      <Panel title="Stages">
        {d.stages.length === 0 ? (
          <div>
            <EmptyState>No workflow applied — apply a template or add tasks.</EmptyState>
            {d.applicableTemplates.length > 0 ? (
              <form action={applyTemplateAction} className="mt-2 flex items-end gap-2">
                <input type="hidden" name="matter" value={id} />
                <Field label="Template">
                  <Select name="template">
                    {d.applicableTemplates.map((t) => (
                      <option key={String(t.id)} value={String(t.id)}>
                        {String(t.name)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <SubmitButton>Apply</SubmitButton>
              </form>
            ) : null}
          </div>
        ) : (
          <DataTable
            headers={['#', 'Stage', 'State', 'Entered', 'Expected days', '']}
            rows={d.stages.map((s) => [
              String(s.position),
              String(s.name),
              <Badge key="s" tone={s.state === 'current' ? 'green' : s.state === 'done' ? 'neutral' : 'blue'}>
                {String(s.state)}
              </Badge>,
              s.entered_at ? fmtDateTime(s.entered_at) : '—',
              s.expected_duration_days != null ? String(s.expected_duration_days) : '—',
              <span key="a" className="flex gap-1">
                {s.state === 'pending' || s.state === 'done' ? (
                  <form action={s.state === 'pending' ? enterStageAction : reopenStageAction}>
                    <input type="hidden" name="matter" value={id} />
                    <input type="hidden" name="stage" value={String(s.id)} />
                    <SubmitButton>{s.state === 'pending' ? 'Enter' : 'Reopen'}</SubmitButton>
                  </form>
                ) : (
                  <form action={completeStageAction}>
                    <input type="hidden" name="matter" value={id} />
                    <input type="hidden" name="stage" value={String(s.id)} />
                    <SubmitButton>Complete</SubmitButton>
                  </form>
                )}
              </span>,
            ])}
          />
        )}
      </Panel>
      <Panel title="Tasks">
        {d.tasks.length === 0 ? (
          <EmptyState>No tasks yet.</EmptyState>
        ) : (
          <DataTable
            headers={['Task', 'Stage', 'Owner', 'Due', 'Done', '', '']}
            rows={d.tasks.map((t) => [
              String(t.title),
              t.stage ? String(d.stages.find((s) => s.id === t.stage)?.name ?? t.stage) : '—',
              t.owner_name ? personName(t.owner_name) : '—',
              t.due_date ? (
                <span key="d">
                  {fmtDate(t.due_date)} {t.overdue ? <Badge tone="red">overdue</Badge> : null}
                </span>
              ) : (
                'awaiting date'
              ),
              t.done ? '✓' : '—',
              <form key="c" action={taskDoneAction}>
                <input type="hidden" name="task" value={String(t.id)} />
                <input type="hidden" name="done" value={String(!t.done)} />
                <input type="hidden" name="back" value={back} />
                <SubmitButton>{t.done ? 'Reopen' : 'Done'}</SubmitButton>
              </form>,
              !t.done ? (
                <form key="x" action={deleteTaskAction}>
                  <input type="hidden" name="task" value={String(t.id)} />
                  <input type="hidden" name="back" value={back} />
                  <button className="text-xs text-neutral-400 hover:text-red-600" type="submit">
                    delete
                  </button>
                </form>
              ) : (
                ''
              ),
            ])}
          />
        )}
        {d.awaitingAnchor.length > 0 ? (
          <p className="mt-2 text-xs text-neutral-500">
            {d.awaitingAnchor.length} task(s) await an anchor date before their due dates exist.
          </p>
        ) : null}
        <form action={createTaskAction} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="matter" value={id} />
          <Field label="New task">
            <TextInput name="title" />
          </Field>
          <Field label="Owner">
            <Select name="owner">
              {d.staff.map((s) => (
                <option key={String(s.id)} value={String(s.id)}>
                  {personName(s.person_name)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due (optional)">
            <TextInput name="due_date" type="date" />
          </Field>
          <SubmitButton>Add task</SubmitButton>
        </form>
      </Panel>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Key dates">
          {d.keyDates.length === 0 ? (
            <EmptyState>No key dates recorded.</EmptyState>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.keyDates.map((k) => (
                <li key={String(k.id)} className="flex flex-wrap items-center gap-2">
                  <span className="tabular-nums">{fmtDateTime(k.starts_at)}</span>
                  <span>{String(k.title)}</span>
                  <span className="text-xs text-neutral-400">({String(k.type_label)})</span>
                  {k.critical ? <Badge tone="red">critical</Badge> : null}
                  {k.done ? <Badge tone="neutral">done</Badge> : null}
                  {!k.done ? (
                    <>
                      <form action={keyDateDoneAction}>
                        <input type="hidden" name="key_date" value={String(k.id)} />
                        <input type="hidden" name="done" value="true" />
                        <input type="hidden" name="back" value={back} />
                        <button className="text-xs underline" type="submit">
                          done
                        </button>
                      </form>
                      <form action={keyDateCriticalAction}>
                        <input type="hidden" name="key_date" value={String(k.id)} />
                        <input type="hidden" name="critical" value={String(!k.critical)} />
                        <input type="hidden" name="back" value={back} />
                        <button className="text-xs underline" type="submit">
                          {k.critical ? 'not critical' : 'mark critical'}
                        </button>
                      </form>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <form action={createKeyDateAction} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="matter" value={id} />
            <Field label="Title">
              <TextInput name="title" />
            </Field>
            <Field label="Type">
              <Select name="type_key">
                {d.keyDateTypes.map((t) => (
                  <option key={String(t.shipped_key)} value={String(t.shipped_key)}>
                    {String(t.label)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="When">
              <TextInput name="starts_at" type="datetime-local" />
            </Field>
            <label className="mb-2 flex items-center gap-1 text-sm text-neutral-600">
              <input type="checkbox" name="critical" /> critical
            </label>
            <SubmitButton>Add</SubmitButton>
          </form>
        </Panel>
        <Panel title="Anchor dates">
          {d.anchors.length === 0 ? (
            <EmptyState>No anchor definitions exist.</EmptyState>
          ) : (
            <ul className="space-y-2 text-sm">
              {d.anchors.map((a) => (
                <li key={String(a.definition)} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{String(a.name)}:</span>
                  <span className="tabular-nums">{a.value ? fmtDate(a.value) : 'not set'}</span>
                  <form action={setAnchorAction} className="flex items-center gap-1">
                    <input type="hidden" name="matter" value={id} />
                    <input type="hidden" name="definition" value={String(a.definition)} />
                    <TextInput name="value" type="date" />
                    <SubmitButton>{a.value ? 'Change' : 'Set'}</SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-neutral-500">
            Changing an anchor never moves dependent dates by itself — a proposal appears for
            confirmation.
          </p>
        </Panel>
      </div>
    </Page>
  )
}
