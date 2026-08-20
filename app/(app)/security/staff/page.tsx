// Staff screen: list visible to all staff (names and offices); creation
// and edits under roles.manage on the detail screen.

import { requirePrincipal, viewerContext } from '@/lib/auth'
import { staffList } from '@/lib/reads/security'
import { withPrincipal } from '@/lib/db'
import { Page, Panel, DataTable, Badge, Notices, RowLink, personName } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { addStaff } from '../actions'

export default async function StaffPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const viewer = await viewerContext(p)
  const filter = sp.show === 'inactive' ? { active: false } : sp.show === 'all' ? {} : { active: true }
  const rows = await staffList(p, filter)
  const manages = viewer.capabilities.has('roles.manage')
  const options = manages
    ? await withPrincipal(
        p,
        async (tx) => {
          const roles = await tx.query(
            `select id, name from deedbox.role where active and not external order by name`,
          )
          const offices = await tx.query(`select id, name from deedbox.office where active order by name`)
          return { roles: roles.rows, offices: offices.rows }
        },
        { readOnly: true },
      )
    : null
  return (
    <Page
      title="Staff"
      lead="Everyone at the firm. Open a person for their role, factors and account state."
      actions={
        <span className="text-sm">
          <a href="?show=active" className="text-sky-700 hover:underline">Active</a>
          {' · '}
          <a href="?show=inactive" className="text-sky-700 hover:underline">Inactive</a>
          {' · '}
          <a href="?show=all" className="text-sky-700 hover:underline">All</a>
        </span>
      }
    >
      <Notices searchParams={sp} />
      <Panel>
        <DataTable
          headers={['Name', 'Login', 'Role', 'Office', 'State', 'MFA']}
          emptyState="No staff match this filter."
          rows={rows.map((s) => [
            manages ? <RowLink key="l" href={`/security/staff/${s.id}`}>{personName(s.person_name)}</RowLink> : personName(s.person_name),
            s.login,
            s.role_name,
            s.office_name,
            s.active ? <Badge tone="green">active</Badge> : <Badge tone="red">inactive</Badge>,
            s.mfa_enrolled ? <Badge tone="blue">enrolled</Badge> : '—',
          ])}
        />
      </Panel>
      {manages && options ? (
        <Panel title="Add a staff member">
          <form action={addStaff} className="grid max-w-2xl grid-cols-2 gap-x-4">
            <Field label="Given name">
              <TextInput name="given" />
            </Field>
            <Field label="Family name">
              <TextInput name="family" />
            </Field>
            <Field label="Login" hint="Unique; case does not matter.">
              <TextInput name="login" required />
            </Field>
            <Field label="Email">
              <TextInput name="email" type="email" required />
            </Field>
            <Field label="Role">
              <Select name="role" required>
                {options.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Office">
              <Select name="office" required>
                {options.offices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div>
              <SubmitButton>Create</SubmitButton>
            </div>
          </form>
        </Panel>
      ) : null}
    </Page>
  )
}
