// Create party with the duplicate-candidates dialog. The action runs
// the duplicate check first; candidates re-render this screen side-by-side
// with "use existing" and "create anyway" — abandoning writes nothing, and
// the operation re-runs the check inside its own transaction regardless.

import { requirePrincipal } from '@/lib/auth'
import { checkDuplicates } from '@/lib/ops/matters'
import { Page, Panel, DataTable, Notices, RowLink, Badge } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { addParty } from '../actions'

export default async function NewPartyPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const showingDialog = sp.dup === '1' && (sp.full_name ?? '') !== ''
  const candidates = showingDialog
    ? await checkDuplicates(p, {
        name: sp.full_name,
        phone: sp.phone || undefined,
        email: sp.email || undefined,
      })
    : []

  return (
    <Page
      title="New party"
      lead="A person or organisation. The duplicate check runs before anything is created."
    >
      <Notices searchParams={sp} />

      {showingDialog && candidates.length > 0 ? (
        <Panel title="Possible existing matches — check before creating">
          <p className="mb-3 text-sm text-neutral-600">
            These existing parties match the name and contact details you entered. Using the
            existing record keeps the history in one place; creating anyway records this decision
            permanently.
          </p>
          <DataTable
            headers={['Existing party', 'Names', 'Phone', 'Email', 'Shared matters', '']}
            rows={candidates.map((c) => [
              <RowLink key="n" href={`/parties/${c.party}`}>
                {c.displayName}
              </RowLink>,
              c.names.map((n) => n.fullName).join(' · '),
              c.phones.join(', ') || '—',
              c.emails.join(', ') || '—',
              <span key="m">
                {c.visibleMatters.map((m) => (
                  <RowLink key={m.id} href={`/matters/${m.id}`}>
                    {m.matterNumber}{' '}
                  </RowLink>
                ))}
                {c.hiddenMatterCount > 0 ? (
                  <Badge tone="amber">{c.hiddenMatterCount} you cannot see</Badge>
                ) : null}
              </span>,
              <RowLink key="u" href={`/parties/${c.party}`}>
                Use existing
              </RowLink>,
            ])}
          />
        </Panel>
      ) : null}

      <Panel title={showingDialog && candidates.length > 0 ? 'Or create anyway' : 'Details'}>
        <form action={addParty} className="max-w-lg">
          {showingDialog && candidates.length > 0 ? (
            <input type="hidden" name="proceed_with_candidates" value="on" />
          ) : null}
          <Field label="Kind">
            <Select name="kind" defaultValue={sp.kind ?? 'person'}>
              <option value="person">Person</option>
              <option value="organisation">Organisation</option>
            </Select>
          </Field>
          <Field label="Full name">
            <TextInput name="full_name" defaultValue={sp.full_name ?? ''} required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Given names" hint="People only — optional">
              <TextInput name="given" defaultValue={sp.given ?? ''} />
            </Field>
            <Field label="Family name">
              <TextInput name="family" defaultValue={sp.family ?? ''} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone" hint="Becomes the primary phone">
              <TextInput name="phone" defaultValue={sp.phone ?? ''} />
            </Field>
            <Field label="Email" hint="Becomes the primary email">
              <TextInput name="email" defaultValue={sp.email ?? ''} />
            </Field>
          </div>
          <Field label="Notes">
            <TextArea name="notes" rows={3} defaultValue={sp.notes ?? ''} />
          </Field>
          <SubmitButton>
            {showingDialog && candidates.length > 0 ? 'Create anyway' : 'Create party'}
          </SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
