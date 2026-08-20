// Register screen: the filterable stream; each entry expandable to its
// detail; matter-linked entries pass the viewer's predicate in the read.

import { requirePrincipal } from '@/lib/auth'
import { registerStream } from '@/lib/reads/security'
import { Page, Panel, Badge, EmptyState, Notices, fmtDateTime, personName } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'

export default async function RegisterScreen({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const entries = await registerStream(p, {
    actorKind: sp.actor_kind || undefined,
    eventKind: sp.event_kind || undefined,
    namespace: sp.area || undefined,
    from: sp.from || undefined,
    to: sp.to || undefined,
    matter: sp.matter ? Number(sp.matter) : undefined,
    subjectType: sp.subject_type || undefined,
    privilegedOnly: sp.privileged === 'on',
    before: sp.before ? Number(sp.before) : undefined,
  })
  return (
    <Page
      title="Register"
      lead="The append-only record of everything that has happened. Filter, expand an entry for its detail, and page back through time."
    >
      <Notices searchParams={sp} />
      <Panel title="Filters">
        <form method="get" className="grid grid-cols-2 gap-x-4 md:grid-cols-4">
          <Field label="Area">
            <TextInput name="area" defaultValue={sp.area ?? ''} placeholder="e.g. money, signin" />
          </Field>
          <Field label="Event kind">
            <TextInput name="event_kind" defaultValue={sp.event_kind ?? ''} placeholder="e.g. bill.issued" />
          </Field>
          <Field label="Actor kind">
            <Select name="actor_kind" defaultValue={sp.actor_kind ?? ''}>
              <option value="">Any</option>
              <option value="staff">Staff</option>
              <option value="system_job">System</option>
              <option value="integration_key">Integration key</option>
              <option value="examiner">Examiner</option>
              <option value="portal_client">Portal client</option>
            </Select>
          </Field>
          <Field label="Matter #">
            <TextInput name="matter" defaultValue={sp.matter ?? ''} />
          </Field>
          <Field label="From">
            <TextInput name="from" type="datetime-local" defaultValue={sp.from ?? ''} />
          </Field>
          <Field label="To">
            <TextInput name="to" type="datetime-local" defaultValue={sp.to ?? ''} />
          </Field>
          <div className="pt-6">
            <Checkbox name="privileged" label="Privileged only" defaultChecked={sp.privileged === 'on'} />
          </div>
          <div className="pt-6">
            <SubmitButton tone="quiet">Apply filters</SubmitButton>
          </div>
        </form>
      </Panel>
      <Panel title={`Entries${entries.length ? ` (${entries.length})` : ''}`}>
        {entries.length === 0 ? (
          <EmptyState>No register entries match these filters.</EmptyState>
        ) : (
          <div className="divide-y divide-neutral-100">
            {entries.map((e) => (
              <details key={e.id} className="py-1.5 text-sm">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <span className="tabular-nums text-neutral-400">{fmtDateTime(e.occurred_at)}</span>
                  <span className="font-medium text-neutral-800">{e.event_kind}</span>
                  {e.privileged ? <Badge tone="violet">privileged</Badge> : null}
                  <span className="text-neutral-500">
                    {e.actor_kind === 'staff' ? personName(e.actor_name) : e.actor_kind}
                  </span>
                  <span className="text-neutral-400">
                    {e.subject_type} #{e.subject}
                    {e.matter ? ` · matter #${e.matter}` : ''}
                  </span>
                </summary>
                <div className="mt-1 rounded bg-neutral-50 p-2">
                  {e.reason ? <p className="mb-1 text-neutral-700">Reason: {e.reason}</p> : null}
                  <pre className="overflow-x-auto text-xs text-neutral-600">
                    {JSON.stringify(e.detail, null, 2)}
                  </pre>
                  {e.artefact ? <p className="mt-1 text-xs text-neutral-400">Artefact: {e.artefact}</p> : null}
                </div>
              </details>
            ))}
          </div>
        )}
        {entries.length >= 100 ? (
          <p className="mt-3 text-sm">
            <a
              className="text-sky-700 hover:underline"
              href={`?${new URLSearchParams({ ...sp, before: String(entries[entries.length - 1].id) }).toString()}`}
            >
              Older entries →
            </a>
          </p>
        ) : null}
      </Panel>
    </Page>
  )
}
