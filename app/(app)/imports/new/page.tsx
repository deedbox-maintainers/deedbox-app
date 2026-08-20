// The import wizard: records in, mapping chosen, validate-only first —
// the same pipeline as the real run, rolled back by design, with the full
// per-record disposition report.

import { requirePrincipal } from '@/lib/auth'
import { importScreens } from '@/lib/reads/operations'
import { Page, Panel, Notices, RowLink } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { runBatchAction, saveMappingAction } from '../actions'

const DOMAINS = ['clients', 'matters', 'client_money_opening_balances', 'client_money_full_history', 'bills', 'time', 'other']

export default async function ImportWizardPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const d = await importScreens(p)

  return (
    <Page
      title="New import"
      lead={
        <span>
          Validate first: the validate-only run executes the whole pipeline and rolls it back —
          the report is real, the database untouched. <RowLink href="/imports">Back to batches</RowLink>
        </span>
      }
    >
      <Notices searchParams={sp} />
      <Panel title="Run a batch">
        <form action={runBatchAction} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Record domain">
              <Select name="record_domain">
                {DOMAINS.map((x) => (
                  <option key={x} value={x}>
                    {x.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Source system">
              <TextInput name="source_system" />
            </Field>
            <Field label="Mapping template (optional)">
              <Select name="mapping">
                <option value="">none</option>
                {d.mappings
                  .filter((m) => m.active)
                  .map((m) => (
                    <option key={String(m.id)} value={String(m.id)}>
                      {String(m.name)} ({String(m.origin)})
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Migration (optional)">
              <Select name="migration">
                <option value="">none</option>
                {d.migrations
                  .filter((m) => !m.completed_at)
                  .map((m) => (
                    <option key={String(m.id)} value={String(m.id)}>
                      #{String(m.id)} {String(m.source_system)}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Mode">
              <Select name="mode">
                <option value="validate_only">validate only (writes nothing)</option>
                <option value="real">real run</option>
              </Select>
            </Field>
          </div>
          <Field label='Records (JSON array of {"source_ref", "data"})'>
            <TextArea name="records" rows={8} />
          </Field>
          <SubmitButton>Run the batch</SubmitButton>
        </form>
      </Panel>
      <Panel title="Save a mapping template">
        <form action={saveMappingAction} className="flex flex-wrap items-end gap-3">
          <Field label="Name">
            <TextInput name="name" />
          </Field>
          <Field label="Source format key">
            <TextInput name="source_format_key" />
          </Field>
          <Field label="Record type">
            <TextInput name="record_type" />
          </Field>
          <Field label="Field map (JSON)">
            <TextInput name="field_map" defaultValue="{}" />
          </Field>
          <SubmitButton>Save template</SubmitButton>
        </form>
        <p className="mt-2 text-xs text-neutral-500">
          Product and pack templates are read-only; yours carry the firm origin.
        </p>
      </Panel>
    </Page>
  )
}
