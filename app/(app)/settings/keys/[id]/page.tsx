// Key detail: the submissions this key created and its register trail,
// exportable as one recorded artefact.

import { requirePrincipal } from '@/lib/auth'
import { keyDetail } from '@/lib/reads/operations'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink, Badge, fmtDateTime, fmtJson, personName } from '@/components/ui'
import { SubmitButton, Field, Select } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { exportKeyActivityAction, setKeyDefaultsAction, clearKeyDefaultsAction } from '../actions'

export default async function KeyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const d = await keyDetail(p, Number(id))
  const k = d.key

  return (
    <Page
      title={`${String(k.label)} (${String(k.key_display)})`}
      lead={
        <span className="flex flex-wrap items-center gap-2">
          {k.test_mode ? <Badge tone="violet">test</Badge> : null}
          {k.revoked_at ? <Badge tone="red">revoked</Badge> : <Badge tone="green">active</Badge>}
          <RowLink href="/settings/keys">All keys</RowLink>
          <form action={exportKeyActivityAction}>
            <input type="hidden" name="key" value={String(k.id)} />
            <SubmitButton>Export activity</SubmitButton>
          </form>
        </span>
      }
    >
      <Notices searchParams={sp} />
      <Panel title="Matter-door creation defaults">
        <p className="mb-2 text-xs text-neutral-500">
          A matter delivered through this key opens under these. Without them the matter door
          refuses; the intake-record door and identity check are unaffected.
        </p>
        <form action={setKeyDefaultsAction} className="flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="key" value={String(k.id)} />
          <Field label="Office">
            <Select name="office" defaultValue={d.defaults ? String(d.defaults.office) : ''} required>
              <option value="" disabled>
                Choose…
              </option>
              {d.offices.map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {String(o.name)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Responsible lawyer">
            <Select
              name="responsible_lawyer"
              defaultValue={d.defaults ? String(d.defaults.responsible_lawyer) : ''}
              required
            >
              <option value="" disabled>
                Choose…
              </option>
              {d.staff.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {personName(s.person_name)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default practice area">
            <Select
              name="practice_area"
              defaultValue={d.defaults ? String(d.defaults.practice_area) : ''}
              required
            >
              <option value="" disabled>
                Choose…
              </option>
              {d.practiceAreas.map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {String(a.name)}
                </option>
              ))}
            </Select>
          </Field>
          <SubmitButton>{d.defaults ? 'Update defaults' : 'Set defaults'}</SubmitButton>
        </form>
        {d.defaults ? (
          <form action={clearKeyDefaultsAction} className="mt-2">
            <input type="hidden" name="key" value={String(k.id)} />
            <SubmitButton tone="quiet">Clear defaults (closes the matter door)</SubmitButton>
          </form>
        ) : null}
      </Panel>
      <Panel title={`Submissions (${d.submissions.length})`}>
        {d.submissions.length === 0 ? (
          <EmptyState>Nothing submitted with this key yet.</EmptyState>
        ) : (
          <DataTable
            headers={['Received', 'Idempotency key', 'Outcome', 'Created', 'Replay of', 'Test']}
            rows={d.submissions.map((s) => [
              fmtDateTime(s.received_at),
              String(s.idempotency_key),
              String(s.outcome).replace(/_/g, ' '),
              s.created_type !== 'none' ? `${String(s.created_type)} #${String(s.created)}` : '—',
              s.original ? `#${String(s.original)}` : '—',
              s.test ? 'test' : '—',
            ])}
          />
        )}
      </Panel>
      <Panel title="Register trail">
        {d.activity.length === 0 ? (
          <EmptyState>No register events for this key.</EmptyState>
        ) : (
          <DataTable
            headers={['At', 'Event', 'Detail']}
            rows={d.activity.map((a) => [
              fmtDateTime(a.occurred_at),
              String(a.event_kind),
              <pre key="d" className="max-w-md overflow-x-auto whitespace-pre-wrap text-xs">
                {fmtJson(a.detail)}
              </pre>,
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
