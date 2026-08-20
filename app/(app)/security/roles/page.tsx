// Roles & capabilities: the per-role capability matrix with safe-bounds
// explanations inline; money-authorisation capabilities visually distinct
// with their confirmation step.

import { requirePrincipal } from '@/lib/auth'
import { rolesMatrix } from '@/lib/reads/security'
import { Page, Panel, Badge, Notices } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { addRole, setCapability } from '../actions'

export default async function RolesPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const { roles, capabilities, grants } = await rolesMatrix(p)
  const scopeOf = (role: number, cap: string) =>
    grants.find((g) => g.role === role && g.capability === cap)?.scope ?? 'none'
  const internalRoles = roles.filter((r) => !r.external && r.active)
  return (
    <Page
      title="Roles & capabilities"
      lead="What each role can do. External roles can never hold internal capabilities; the administrator role never loses its floor; the last holder of security administration can never lose it. Money-authorisation capabilities are granted only with the distinct confirmation step."
    >
      <Notices searchParams={sp} />
      <Panel title="The matrix">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left">
                <th className="px-2 py-1.5 font-medium text-neutral-500">Capability</th>
                {internalRoles.map((r) => (
                  <th key={r.id} className="px-2 py-1.5 font-medium text-neutral-500">
                    {r.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {capabilities.map((c) => (
                <tr key={c.key} className="border-b border-neutral-100 hover:bg-neutral-50">
                  <td className="px-2 py-1.5">
                    <span className="text-neutral-800">{c.key}</span>{' '}
                    {c.money_authorisation ? <Badge tone="amber">money</Badge> : null}
                    {c.admin_floor ? <Badge tone="violet">admin floor</Badge> : null}
                    {!c.grantable_to_firm_roles ? <Badge tone="neutral">release-set</Badge> : null}
                  </td>
                  {internalRoles.map((r) => {
                    const s = scopeOf(r.id, c.key)
                    return (
                      <td key={r.id} className="px-2 py-1.5">
                        {s === 'none' ? (
                          <span className="text-neutral-300">—</span>
                        ) : s === 'own_figures_only' ? (
                          <Badge tone="blue">own figures</Badge>
                        ) : (
                          <Badge tone="green">yes</Badge>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Change a grant">
        <form action={setCapability} className="grid max-w-3xl grid-cols-2 gap-x-4 md:grid-cols-4">
          <Field label="Role">
            <Select name="role">
              {internalRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Capability">
            <Select name="capability">
              {capabilities
                .filter((c) => c.grantable_to_firm_roles)
                .map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.key}
                    {c.money_authorisation ? ' (money)' : ''}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Scope">
            <Select name="scope">
              <option value="firm_wide">Firm-wide</option>
              <option value="own_figures_only">Own figures only</option>
              <option value="none">Remove</option>
            </Select>
          </Field>
          <div className="pt-6">
            <SubmitButton>Apply</SubmitButton>
          </div>
          <div className="col-span-2 md:col-span-4">
            <Checkbox
              name="confirm_money"
              label="I confirm this grant authorises handling of client money (required for money-authorisation capabilities)."
            />
          </div>
        </form>
      </Panel>
      <Panel title="Add a role">
        <form action={addRole} className="flex max-w-md items-end gap-3">
          <div className="grow">
            <Field label="Role name">
              <TextInput name="name" required />
            </Field>
          </div>
          <div className="pb-3">
            <SubmitButton>Create</SubmitButton>
          </div>
        </form>
      </Panel>
    </Page>
  )
}
