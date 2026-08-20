// Create matter. The conflict gate (practice-area flag OR firm setting)
// is the operation's — this screen offers the check reference field and the
// operation refuses with the gate named when one is demanded and absent. No
// matter number is consumed by a refused create.

import { requirePrincipal } from '@/lib/auth'
import { matterFilterOptions, partyList, partyProfile } from '@/lib/reads/matters'
import { Page, Panel, Notices, DataTable, RowLink } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import PartyPicker from '@/components/party-picker'
import { addMatter } from '../actions'

export default async function NewMatterPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const options = await matterFilterOptions(p)
  const clientSearch = sp.client_q ?? ''
  const clientCandidates = clientSearch ? await partyList(p, { q: clientSearch, limit: 10 }) : []
  // an arriving ?client=<id> (a party page's "new matter" path) pre-fills the picker
  let initialClient: { id: number; text: string } | undefined
  if (sp.client) {
    try {
      const prof = await partyProfile(p, Number(sp.client))
      initialClient = { id: prof.party.id, text: prof.party.displayName }
    } catch {
      initialClient = undefined
    }
  }

  return (
    <Page
      title="New matter"
      lead="The client must already exist as a party — search below, or create them first. The matter number is allocated the moment the matter opens."
    >
      <Notices searchParams={sp} />

      <Panel title="Find the client">
        <form method="get" className="mb-3 flex max-w-md items-center gap-2">
          <TextInput name="client_q" defaultValue={clientSearch} placeholder="Search parties…" />
          <SubmitButton tone="quiet">Search</SubmitButton>
        </form>
        {clientCandidates.length > 0 ? (
          <DataTable
            headers={['Name', 'Phone', 'Email', 'Party #']}
            rows={clientCandidates.map((c) => [
              c.displayName,
              c.primaryPhone ?? '—',
              c.primaryEmail ?? '—',
              String(c.id),
            ])}
          />
        ) : clientSearch ? (
          <p className="text-sm text-neutral-500">
            Nothing matches — <RowLink href="/parties/new">create the party first</RowLink>.
          </p>
        ) : null}
      </Panel>

      <Panel title="Matter details">
        <form action={addMatter} className="max-w-lg">
          <PartyPicker
            name="client_party"
            label="Client"
            hint="Type the client's name and pick — they must already exist as a party"
            initial={initialClient}
          />
          <Field label="Title">
            <TextInput name="title" required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Practice area">
              <Select name="practice_area">
                {options.areas
                  .filter((a) => a.active)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Office">
              <Select name="office">
                {options.offices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Responsible lawyer">
              <Select name="responsible_lawyer">
                {options.lawyers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Jurisdiction" hint="Optional">
              <TextInput name="jurisdiction" />
            </Field>
          </div>
          <Field label="Summary" hint="Optional — searchable and conflict-checked">
            <TextArea name="summary" rows={2} />
          </Field>
          <Field label="Origin note" hint="Optional, descriptive only — changes no figure anywhere">
            <TextInput name="origin_note" />
          </Field>
          <Field
            label="Resolved conflict check #"
            hint="Needed when the practice area or firm settings demand one before opening"
          >
            <TextInput name="conflict_check" inputMode="numeric" />
          </Field>
          <SubmitButton>Open matter</SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
