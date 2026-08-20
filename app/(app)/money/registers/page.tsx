// Statutory registers: one per pack-declared register, the append form
// from its column schema, densely numbered entries with printable artefacts.

import { requirePrincipal } from '@/lib/auth'
import { statutoryRegistersScreen } from '@/lib/reads/money'
import { Page, Panel, DataTable, Notices, EmptyState, fmtDateTime } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { appendRegisterEntryAction } from '../actions'

export default async function StatutoryRegistersPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const d = await statutoryRegistersScreen(p)
  const decl = d.declaration as { registers?: { key: string; columns?: { key: string; label?: string }[] }[] } | null

  return (
    <Page
      title="Statutory registers"
      lead="Registers this jurisdiction's pack declares beyond the core books. Entries append under a per-register lock with dense numbering — never a gap, never an edit."
    >
      <Notices searchParams={sp} />
      {d.registers.length === 0 ? (
        <Panel>
          <EmptyState>This jurisdiction's pack declares no additional registers.</EmptyState>
        </Panel>
      ) : (
        d.registers.map((r) => {
          const columns = decl?.registers?.find((x) => x.key === r.register_key)?.columns ?? []
          return (
            <Panel key={r.id as number} title={`${String(r.name)} (${String(r.entries)} entries)`}>
              <DataTable
                headers={['#', 'Recorded', 'Printable']}
                rows={d.entries
                  .filter((e) => e.register === r.id)
                  .map((e) => [
                    String(e.entry_no),
                    fmtDateTime(e.created_at),
                    e.printable_artefact ? String(e.printable_artefact) : '—',
                  ])}
                emptyState="No entries yet."
              />
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-sky-700">Append an entry</summary>
                <form action={appendRegisterEntryAction} className="mt-2 max-w-md">
                  <input type="hidden" name="register_key" value={String(r.register_key)} />
                  {(columns.length > 0 ? columns : [{ key: 'detail', label: 'Detail' }]).map((c) => (
                    <Field key={c.key} label={c.label ?? c.key.replace(/_/g, ' ')}>
                      <input type="hidden" name="v_key" value={c.key} />
                      <TextInput name="v_value" />
                    </Field>
                  ))}
                  <SubmitButton tone="quiet">Append (validated against the pack schema)</SubmitButton>
                </form>
              </details>
            </Panel>
          )
        })
      )}
    </Page>
  )
}
