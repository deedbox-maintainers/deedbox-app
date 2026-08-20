// My time plus the timer strip. Own entries by date with running
// totals by category; quick entry inline; timers with elapsed and
// pause/stop. The value formula is the schema's — the screen only captures.

import { requirePrincipal } from '@/lib/auth'
import { myTime, myTimers, timeCaptureOptions } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDate } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import MatterPicker from '@/components/matter-picker'
import {
  addTimeEntry,
  startTimerAction,
  pauseTimerAction,
  resumeTimerAction,
  stopTimerAction,
  discardTimerAction,
} from './actions'

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400000)
  return d.toISOString().slice(0, 10)
}

function elapsed(startedAt: string, accumulated: number, state: string): string {
  const secs =
    state === 'running'
      ? accumulated + Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
      : accumulated
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return `${h}h ${String(m).padStart(2, '0')}m`
}

export default async function MyTimePage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const from = sp.from ?? isoDaysAgo(7)
  const to = sp.to ?? isoDaysAgo(0)
  const [time, timers, capture] = await Promise.all([
    myTime(p, { from, to }),
    myTimers(p),
    timeCaptureOptions(p),
  ])

  return (
    <Page
      title="My time"
      lead="Your recorded work. The value of a timed entry follows the firm's unit and your rate — computed by the books, not the screen."
    >
      <Notices searchParams={sp} />

      {timers.length > 0 ? (
        <Panel title="Timers">
          <ul className="space-y-2">
            {timers.map((t) => (
              <li key={t.id as number} className="flex flex-wrap items-center gap-3 text-sm">
                <Badge tone={t.state === 'running' ? 'green' : 'amber'}>{String(t.state)}</Badge>
                <span className="font-medium tabular-nums">
                  {elapsed(String(t.started_at), Number(t.accumulated_seconds), String(t.state))}
                </span>
                <span className="text-neutral-600">
                  {t.matter_number ? `${t.matter_number} — ${t.title}` : 'no matter yet'}
                  {t.narrative_draft ? ` · ${t.narrative_draft}` : ''}
                </span>
                {t.state === 'running' ? (
                  <InlineAction action={pauseTimerAction} fields={{ timer: t.id as number }} label="Pause" />
                ) : (
                  <InlineAction action={resumeTimerAction} fields={{ timer: t.id as number }} label="Resume" />
                )}
                <form action={stopTimerAction} className="flex items-center gap-2">
                  <input type="hidden" name="timer" value={t.id as number} />
                  {!t.matter ? (
                    <TextInput name="matter" placeholder="Matter #" inputMode="numeric" className="!w-24" />
                  ) : null}
                  <TextInput name="narrative" placeholder="Narrative" className="!w-56" />
                  <SubmitButton tone="quiet">Stop & record</SubmitButton>
                </form>
                <InlineAction action={discardTimerAction} fields={{ timer: t.id as number }} label="Discard" />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title={`Entries ${from} – ${to}`}>
            <form method="get" className="mb-3 flex items-end gap-2 text-sm">
              <div className="w-36">
                <Field label="From">
                  <TextInput name="from" type="date" defaultValue={from} />
                </Field>
              </div>
              <div className="w-36">
                <Field label="To">
                  <TextInput name="to" type="date" defaultValue={to} />
                </Field>
              </div>
              <div className="pb-3">
                <SubmitButton tone="quiet">Show</SubmitButton>
              </div>
            </form>
            <DataTable
              headers={['Date', 'Matter', 'Narrative', 'Units', 'Value', 'Category', 'State']}
              rows={time.entries.map((e) => [
                fmtDate(e.work_date),
                <RowLink key="m" href={`/matters/${e.matter}/billing`}>
                  {String(e.matter_number)}
                </RowLink>,
                String(e.narrative),
                e.units === null ? '—' : String(e.units),
                Number(e.value).toFixed(2),
                String(e.category),
                <Badge key="s" tone={e.billed_state === 'unbilled' ? 'blue' : 'neutral'}>
                  {String(e.billed_state).replace(/_/g, ' ')}
                </Badge>,
              ])}
              emptyState="No time recorded — use the quick entry."
            />
          </Panel>
        </div>
        <div>
          <Panel title="Quick entry">
            <form action={addTimeEntry}>
              <MatterPicker
                name="matter"
                label="Matter"
                hint="Start typing the client's name or the matter number, then pick"
              />
              {capture.recordForOthers ? (
                <Field label="Record for" hint="The fee earner whose time this is">
                  <Select name="staff" defaultValue="">
                    <option value="">Myself</option>
                    {capture.staffOptions
                      .filter((s) => s.id !== p.id)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Date">
                  <TextInput name="work_date" type="date" defaultValue={to} required />
                </Field>
                <Field label="Type">
                  <Select name="kind" defaultValue="timed">
                    <option value="timed">Timed (units × rate)</option>
                    <option value="fixed_fee">Fixed fee (amount, no units)</option>
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Units" hint="Timed entries: firm units, e.g. 6-minute">
                  <TextInput name="units" inputMode="numeric" />
                </Field>
                <Field label="Fixed amount" hint="Fixed-fee entries: the fee, tax excluded">
                  <TextInput name="fixed_amount" inputMode="decimal" />
                </Field>
              </div>
              {capture.ownRateLabels.length > 1 ? (
                <Field label="Rate" hint="Your configured rates — timed entries only">
                  <Select name="rate_label" defaultValue="standard">
                    {capture.ownRateLabels.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <Field label="Narrative">
                <TextArea name="narrative" rows={2} required />
              </Field>
              {time.categories.length > 0 ? (
                <Field label="Category">
                  <Select name="category" defaultValue="">
                    <option value="">(default)</option>
                    {time.categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <SubmitButton>Record time</SubmitButton>
            </form>
            <form action={startTimerAction} className="mt-4 border-t border-neutral-100 pt-3">
              <div className="flex items-end gap-2">
                <div className="grow">
                  <MatterPicker name="matter" label="Matter (optional)" />
                </div>
                <div className="pb-3">
                  <SubmitButton tone="quiet">Start a timer</SubmitButton>
                </div>
              </div>
            </form>
          </Panel>
          <Panel title="Totals this period">
            <DataTable
              headers={['Category', 'Entries', 'Value']}
              rows={time.totals.map((t) => [
                <span key="c">
                  {String(t.category)}{' '}
                  {t.counts_as_chargeable ? <Badge tone="green">chargeable</Badge> : null}
                </span>,
                String(t.entries),
                Number(t.value).toFixed(2),
              ])}
              emptyState="Nothing this period."
            />
          </Panel>
        </div>
      </div>
    </Page>
  )
}
