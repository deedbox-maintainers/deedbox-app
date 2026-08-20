// Restriction panel (ships here, once): current grants and blocks,
// the resolved effective membership, and the two-step change flow — propose,
// see the visibility delta (exactly who gains and loses sight, nothing
// written), then commit with the reason. The last-guardian rule is explained
// inline and enforced by the schema. Every open of a restricted matter's
// panel is a recorded disclosure.

import { requirePrincipal } from '@/lib/auth'
import { restrictionPanel } from '@/lib/reads/matters'
import { computeRestrictionDelta } from '@/lib/ops/security'
import type { RestrictionChange } from '@/lib/ops/matters'
import { Page, Panel, DataTable, Notices, RowLink, Badge, EmptyState } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { previewRestrictionAction, commitRestrictionAction } from '../../actions'

function changeFromParams(sp: Record<string, string>): RestrictionChange | null {
  const a = sp.change_action
  if (a === 'add_grant' || a === 'remove_grant') {
    if (!sp.grantee) return null
    return {
      action: a,
      granteeKind: (sp.grantee_kind === 'role' ? 'role' : 'staff') as 'staff' | 'role',
      grantee: Number(sp.grantee),
    }
  }
  if (a === 'add_block' || a === 'remove_block') {
    if (!sp.staff) return null
    return { action: a, staff: Number(sp.staff) }
  }
  return null
}

function describeChange(c: RestrictionChange, panel: { staffOptions: { id: number; name: string }[]; roleOptions: { id: number; name: string }[] }): string {
  if (c.action === 'add_grant' || c.action === 'remove_grant') {
    const name =
      c.granteeKind === 'staff'
        ? panel.staffOptions.find((s) => s.id === c.grantee)?.name ?? `#${c.grantee}`
        : panel.roleOptions.find((r) => r.id === c.grantee)?.name ?? `role #${c.grantee}`
    return `${c.action === 'add_grant' ? 'Grant sight to' : 'Remove the grant for'} ${
      c.granteeKind === 'role' ? `everyone in the role “${name}”` : name
    }`
  }
  const name = panel.staffOptions.find((s) => s.id === c.staff)?.name ?? `#${c.staff}`
  return c.action === 'add_block' ? `Block ${name} from this matter` : `Remove the block on ${name}`
}

export default async function RestrictionPanelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const matterId = Number(id)
  const sp = await readParams(searchParams)
  const panel = await restrictionPanel(p, matterId)
  const proposed = changeFromParams(sp)
  const delta = proposed ? await computeRestrictionDelta(p, { matter: matterId, change: proposed }) : null

  return (
    <Page
      title={`Restriction — ${panel.matter.matterNumber}`}
      lead={
        <span>
          {panel.matter.title} — <RowLink href={`/matters/${panel.matter.id}`}>back to the matter</RowLink>
          . A restricted matter is invisible to everyone without a grant — absent from lists,
          searches, reports and totals, not greyed out. Blocks work the other way: one named person
          loses sight, whatever else says. Every change here is privileged evidence with the
          before/after membership on the register.
        </span>
      }
    >
      <Notices searchParams={sp} />

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <div>
          <Panel
            title={
              panel.matter.restricted ? (
                <span>
                  Currently <Badge tone="violet">restricted</Badge>
                </span>
              ) : (
                'Currently unrestricted'
              )
            }
          >
            <h3 className="mb-1 text-sm font-medium text-neutral-700">Grants (who may see it)</h3>
            <DataTable
              headers={['Who', 'Kind']}
              rows={panel.membership.grants.map((g) => [
                g.name,
                <Badge key="k" tone={g.granteeKind === 'role' ? 'blue' : 'neutral'}>
                  {g.granteeKind}
                </Badge>,
              ])}
              emptyState="No grants — the matter is unrestricted."
            />
            <h3 className="mb-1 mt-4 text-sm font-medium text-neutral-700">Blocks (who may not)</h3>
            <DataTable
              headers={['Who']}
              rows={panel.membership.blocks.map((b) => [b.name])}
              emptyState="No blocks."
            />
            <p className="mt-3 text-xs text-neutral-400">
              The last-guardian rule: the change is refused if it would leave a restricted matter
              with nobody active who can manage its restrictions — the register names the rule when
              it happens.
            </p>
          </Panel>

          <Panel title="Who can see this matter right now">
            {panel.effectiveViewers.length === 0 ? (
              <EmptyState>Nobody — this state cannot normally be reached.</EmptyState>
            ) : (
              <p className="text-sm text-neutral-800">
                {panel.effectiveViewers.map((v) => v.name).join(' · ')}
                <span className="ml-2 text-neutral-400">({panel.effectiveViewers.length})</span>
              </p>
            )}
          </Panel>
        </div>

        <div>
          <Panel title="Propose a change — nothing happens until you commit">
            <form action={previewRestrictionAction} className="max-w-md">
              <input type="hidden" name="matter" value={matterId} />
              <Field label="Change">
                <Select name="change_action" defaultValue={sp.change_action ?? 'add_grant'}>
                  <option value="add_grant">Add a grant</option>
                  <option value="remove_grant">Remove a grant</option>
                  <option value="add_block">Add a block</option>
                  <option value="remove_block">Remove a block</option>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Grant to (for grants)">
                  <Select name="grantee_kind" defaultValue={sp.grantee_kind ?? 'staff'}>
                    <option value="staff">A person</option>
                    <option value="role">A role</option>
                  </Select>
                </Field>
                <Field label="Person / role">
                  <Select name="grantee" defaultValue={sp.grantee ?? ''}>
                    <option value="">—</option>
                    <optgroup label="People">
                      {panel.staffOptions.map((s) => (
                        <option key={`s${s.id}`} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Roles">
                      {panel.roleOptions.map((r) => (
                        <option key={`r${r.id}`} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </optgroup>
                  </Select>
                </Field>
              </div>
              <Field label="Person (for blocks)">
                <Select name="staff" defaultValue={sp.staff ?? ''}>
                  <option value="">—</option>
                  {panel.staffOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <SubmitButton tone="quiet">Preview who gains and loses sight</SubmitButton>
            </form>
          </Panel>

          {proposed && delta ? (
            <Panel title="The visibility delta — before commit">
              <p className="mb-2 text-sm font-medium text-neutral-800">
                {describeChange(proposed, panel)}
              </p>
              <p className="mb-3 text-sm text-neutral-600">
                {delta.restrictedNow !== delta.restrictedAfter ? (
                  delta.restrictedAfter ? (
                    <Badge tone="violet">this makes the matter RESTRICTED</Badge>
                  ) : (
                    <Badge tone="green">this LIFTS the restriction</Badge>
                  )
                ) : null}{' '}
                Sees it now: {delta.seesNow} · after: {delta.seesAfter}
              </p>
              {delta.gains.length > 0 ? (
                <p className="mb-2 text-sm">
                  <span className="font-medium text-emerald-700">Gains sight:</span>{' '}
                  {delta.gains.map((g) => g.name).join(' · ')}
                </p>
              ) : null}
              {delta.loses.length > 0 ? (
                <p className="mb-2 text-sm">
                  <span className="font-medium text-red-700">Loses sight:</span>{' '}
                  {delta.loses.map((l) => l.name).join(' · ')}
                </p>
              ) : null}
              {delta.portalLoses.length > 0 ? (
                <p className="mb-2 text-sm">
                  <span className="font-medium text-red-700">Client portal loses it too:</span>{' '}
                  {delta.portalLoses.map((l) => l.name).join(' · ')}
                </p>
              ) : null}
              {delta.portalGains.length > 0 ? (
                <p className="mb-2 text-sm">
                  <span className="font-medium text-emerald-700">Client portal regains:</span>{' '}
                  {delta.portalGains.map((l) => l.name).join(' · ')}
                </p>
              ) : null}
              {delta.gains.length === 0 && delta.loses.length === 0 ? (
                <p className="mb-2 text-sm text-neutral-500">No one's sight changes.</p>
              ) : null}
              <form action={commitRestrictionAction} className="mt-3 max-w-md border-t border-neutral-100 pt-3">
                <input type="hidden" name="matter" value={matterId} />
                <input type="hidden" name="change_action" value={proposed.action} />
                {'granteeKind' in proposed ? (
                  <>
                    <input type="hidden" name="grantee_kind" value={proposed.granteeKind} />
                    <input type="hidden" name="grantee" value={proposed.grantee} />
                  </>
                ) : (
                  <input type="hidden" name="staff" value={proposed.staff} />
                )}
                <Field label="Reason (always recorded)">
                  <TextInput name="reason" required />
                </Field>
                <SubmitButton tone="danger">Commit this change</SubmitButton>
              </form>
            </Panel>
          ) : null}
        </div>
      </div>
    </Page>
  )
}
