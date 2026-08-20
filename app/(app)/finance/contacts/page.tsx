// Office contacts: the suppliers and payees of the firm's
// own spending — separate from the practice's parties by design.

import { requirePrincipal } from '@/lib/auth'
import { glContacts } from '@/lib/reads/gl'
import { Page, Panel, Notices, DataTable } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { createContactAction } from '../actions'

export default async function ContactsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const contacts = await glContacts(p)
  return (
    <Page title="Office contacts" lead="Who the firm buys from. Kept apart from clients and parties on purpose.">
      <Notices searchParams={sp} />
      <Panel>
        <DataTable
          headers={['Name', 'Email', 'Phone', 'Tax id', 'Bills']}
          rows={(contacts as Record<string, unknown>[]).map((c) => [
            c.name as string,
            (c.email as string | null) ?? '—',
            (c.phone as string | null) ?? '—',
            (c.tax_identifier as string | null) ?? '—',
            c.bills as number,
          ])}
          emptyState="No contacts yet."
        />
        <form action={createContactAction} className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Name"><TextInput name="name" required /></Field>
          <Field label="Email"><TextInput name="email" /></Field>
          <Field label="Phone"><TextInput name="phone" /></Field>
          <Field label="Tax identifier"><TextInput name="tax_identifier" /></Field>
          <SubmitButton tone="quiet">Add contact</SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
