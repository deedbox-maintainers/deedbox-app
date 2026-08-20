// Record an approach — match-or-create for the prospect party with the
// same duplicate dialog as party creation. Phone is the one required contact
// detail; an address is never demanded.

import { requirePrincipal } from '@/lib/auth'
import { checkDuplicates } from '@/lib/ops/matters'
import { matterFilterOptions, intakeBoard } from '@/lib/reads/matters'
import { Page, Panel, DataTable, Notices, RowLink } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { addIntake } from '../actions'

export default async function NewIntakePage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const [options, board] = await Promise.all([matterFilterOptions(p), intakeBoard(p, {})])
  const showingDialog = sp.dup === '1' && (sp.prospect_name ?? '') !== ''
  const candidates = showingDialog
    ? await checkDuplicates(p, {
        name: sp.prospect_name,
        phone: sp.contact_phone || undefined,
        email: sp.contact_email || undefined,
      })
    : []

  return (
    <Page
      title="Record approach"
      lead="A new enquiry before it becomes a matter. If the person already exists, use their record — the check below runs before anything is created."
    >
      <Notices searchParams={sp} />

      {showingDialog && candidates.length > 0 ? (
        <Panel title="Possible existing matches">
          <DataTable
            headers={['Existing party', 'Phone', 'Email', '']}
            rows={candidates.map((c) => [
              <RowLink key="n" href={`/parties/${c.party}`}>
                {c.displayName}
              </RowLink>,
              c.phones.join(', ') || '—',
              c.emails.join(', ') || '—',
              <span key="use" className="text-neutral-500">
                use party #{c.party} below
              </span>,
            ])}
          />
        </Panel>
      ) : null}

      <Panel title={showingDialog && candidates.length > 0 ? 'Create anyway, or use an existing party' : 'Details'}>
        <form action={addIntake} className="max-w-lg">
          {showingDialog && candidates.length > 0 ? (
            <input type="hidden" name="proceed_with_candidates" value="on" />
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Prospect name" hint="Creates a new party unless an existing # is given">
              <TextInput name="prospect_name" defaultValue={sp.prospect_name ?? ''} />
            </Field>
            <Field label="…or existing party #" hint="Overrides the name">
              <TextInput name="prospect_party" inputMode="numeric" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contact phone">
              <TextInput name="contact_phone" required defaultValue={sp.contact_phone ?? ''} />
            </Field>
            <Field label="Contact email" hint="Optional">
              <TextInput name="contact_email" defaultValue={sp.contact_email ?? ''} />
            </Field>
          </div>
          <Field label="What they need (about)">
            <TextArea name="about" rows={3} required defaultValue={sp.about ?? ''} />
          </Field>
          <Field label="Notes" hint="Optional">
            <TextArea name="notes" rows={2} defaultValue={sp.notes ?? ''} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Practice area" hint="Optional">
              <Select name="practice_area" defaultValue={sp.practice_area ?? ''}>
                <option value="">—</option>
                {options.areas
                  .filter((a) => a.active)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Stage" hint="Optional">
              <Select name="stage" defaultValue={sp.stage ?? ''}>
                <option value="">—</option>
                {board.stages
                  .filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <SubmitButton>
            {showingDialog && candidates.length > 0 ? 'Create anyway' : 'Record approach'}
          </SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
