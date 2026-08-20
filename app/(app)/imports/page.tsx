// Import batch list + mapping templates + migration record. The wizard
// lives at /imports/new; every batch's per-record dispositions live on its
// own screen.

import { requirePrincipal } from '@/lib/auth'
import { importScreens } from '@/lib/reads/operations'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink, Badge, fmtDateTime, fmtJson } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { startMigrationAction, completeMigrationAction } from './actions'

const STATE_TONES: Record<string, 'green' | 'amber' | 'red' | 'neutral' | 'blue'> = {
  completed: 'green',
  running: 'blue',
  refused: 'red',
  reversed: 'neutral',
  partially_blocked: 'amber',
}

export default async function ImportsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const d = await importScreens(p)

  return (
    <Page
      title="Imports"
      lead={
        <span>
          <RowLink href="/imports/new">Start with a validate-only run — it writes nothing.</RowLink>
        </span>
      }
    >
      <Notices searchParams={sp} />
      <Panel title="Batches">
        {d.batches.length === 0 ? (
          <EmptyState>No imports — start with a validate-only run; it writes nothing.</EmptyState>
        ) : (
          <DataTable
            headers={['#', 'Domain', 'Mode', 'State', 'Source system', 'Started', '']}
            rows={d.batches.map((b) => [
              String(b.id),
              String(b.record_domain).replace(/_/g, ' '),
              String(b.mode).replace(/_/g, ' '),
              <Badge key="s" tone={STATE_TONES[String(b.state)] ?? 'neutral'}>
                {String(b.state).replace(/_/g, ' ')}
              </Badge>,
              String(b.source_system),
              fmtDateTime(b.started_at),
              <RowLink key="o" href={`/imports/${b.id}`}>
                Open
              </RowLink>,
            ])}
          />
        )}
      </Panel>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Mapping templates">
          {d.mappings.length === 0 ? (
            <EmptyState>No mapping templates yet — save one from the wizard.</EmptyState>
          ) : (
            <DataTable
              headers={['Name', 'Origin', 'Format', 'Record type', 'Active']}
              rows={d.mappings.map((m) => [
                String(m.name),
                String(m.origin),
                String(m.source_format_key),
                String(m.record_type),
                m.active ? 'yes' : 'no',
              ])}
            />
          )}
        </Panel>
        <Panel title="Migrations">
          {d.migrations.length === 0 ? (
            <EmptyState>No migration record is open.</EmptyState>
          ) : (
            <DataTable
              headers={['#', 'Source system', 'Started', 'Completed', 'Record']}
              rows={d.migrations.map((m) => [
                String(m.id),
                String(m.source_system),
                fmtDateTime(m.started_at),
                m.completed_at ? fmtDateTime(m.completed_at) : '—',
                m.summary_artefact ? `artefact #${String(m.summary_artefact)}` : '—',
              ])}
            />
          )}
          <div className="mt-3 flex flex-wrap gap-3">
            <form action={startMigrationAction} className="flex items-end gap-2">
              <Field label="Open a migration (source system)">
                <TextInput name="source_system" />
              </Field>
              <SubmitButton>Open</SubmitButton>
            </form>
            <form action={completeMigrationAction} className="flex items-end gap-2">
              <Field label="Complete migration #">
                <TextInput name="migration" type="number" />
              </Field>
              <SubmitButton>Complete</SubmitButton>
            </form>
          </div>
        </Panel>
      </div>
    </Page>
  )
}
