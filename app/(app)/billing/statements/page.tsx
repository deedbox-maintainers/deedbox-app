// Statements: numbered snapshots per client or matter with artefacts,
// and the one-action allocation launcher whose skips are itemised.

import { requirePrincipal } from '@/lib/auth'
import { statementsScreen } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, fmtDateTime } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { generateStatementAction, allocateStatementAction } from '../actions'

export default async function StatementsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await statementsScreen(p)
  return (
    <Page
      title="Statements"
      lead="A numbered, permanent snapshot of what a client or matter owes, with ageing. Generating never changes a bill; allocation is a separate deliberate act."
    >
      <Notices searchParams={sp} />
      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <Panel title="Generate">
          <form action={generateStatementAction} className="max-w-sm">
            <div className="grid grid-cols-2 gap-3">
              <Field label="For">
                <Select name="scope_kind" defaultValue="client">
                  <option value="client">A client (party #)</option>
                  <option value="matter">A matter (#)</option>
                </Select>
              </Field>
              <Field label="#">
                <TextInput name="scope" required inputMode="numeric" />
              </Field>
            </div>
            <Checkbox name="with_reference" label="Issue a payment reference for the statement" />
            <SubmitButton>Generate statement</SubmitButton>
          </form>
        </Panel>
        <Panel title="Allocate a payment across a statement">
          <form action={allocateStatementAction} className="max-w-sm">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Statement #">
                <TextInput name="statement" required inputMode="numeric" />
              </Field>
              <Field label="Payment #">
                <TextInput name="payment" required inputMode="numeric" />
              </Field>
            </div>
            <p className="mb-2 text-xs text-neutral-400">
              Runs the firm's allocation order across the statement's bills; disputed and arranged
              bills skip, each skip itemised in the outcome.
            </p>
            <SubmitButton tone="quiet">Allocate</SubmitButton>
          </form>
        </Panel>
      </div>
      <Panel title="Statements issued">
        <DataTable
          headers={['Number', 'For', 'As at']}
          rows={rows.map((s) => [
            String(s.statement_number),
            `${String(s.scope_kind)}: ${String(s.scope_label ?? s.scope)}`,
            fmtDateTime(s.as_at),
          ])}
          emptyState="No statements yet."
        />
      </Panel>
    </Page>
  )
}
