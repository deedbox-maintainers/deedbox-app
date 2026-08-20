// Rates admin: staff rates and matter overrides as append-only
// effective-dated lists; the cost-rates tab renders only what row security
// serves (see_cost_rates); cost types; the firm interest policy.

import { requirePrincipal } from '@/lib/auth'
import { ratesAdmin } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, Badge, fmtDate } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  addStaffRateAction,
  addCostRateAction,
  addOverrideAction,
  addCostTypeAction,
  deactivateCostTypeAction,
  saveInterestPolicyAction,
} from '../actions'

export default async function RatesPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const data = await ratesAdmin(p)

  return (
    <Page
      title="Rates & cost types"
      lead="Histories are append-only: a new rate takes effect from its date, and nothing past ever rewrites. Cost rates are visible only to those cleared to see them."
    >
      <Notices searchParams={sp} />
      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <div>
          <Panel title="Staff charge rates">
            <DataTable
              headers={['Staff', 'Label', 'Rate', 'From']}
              rows={data.staffRates.map((r) => [
                String((r.person_name as { family?: string })?.family ?? ''),
                String(r.label),
                Number(r.rate).toFixed(2),
                fmtDate(r.effective_from),
              ])}
              emptyState="No rates yet — time entries need one to value themselves."
            />
            <form action={addStaffRateAction} className="mt-3 grid max-w-md grid-cols-4 items-end gap-2">
              <Field label="Staff">
                <Select name="staff">
                  {data.staffOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Label" hint="e.g. standard">
                <TextInput name="label" />
              </Field>
              <Field label="Rate/h">
                <TextInput name="rate" required inputMode="decimal" />
              </Field>
              <Field label="From">
                <TextInput name="effective_from" type="date" required />
              </Field>
              <div className="col-span-4">
                <SubmitButton tone="quiet">Add rate</SubmitButton>
              </div>
            </form>
          </Panel>

          <Panel title="Matter rate overrides">
            <DataTable
              headers={['Matter', 'Staff', 'Label', 'Rate', 'From']}
              rows={data.overrides.map((o) => [
                String(o.matter_number),
                o.person_name ? String((o.person_name as { family?: string })?.family ?? '') : 'all staff',
                o.label ? String(o.label) : '—',
                Number(o.rate).toFixed(2),
                fmtDate(o.effective_from),
              ])}
              emptyState="No overrides."
            />
            <form action={addOverrideAction} className="mt-3 grid max-w-md grid-cols-4 items-end gap-2">
              <Field label="Matter #">
                <TextInput name="matter" required inputMode="numeric" />
              </Field>
              <Field label="Staff" hint="Blank = all">
                <Select name="staff" defaultValue="">
                  <option value="">All staff</option>
                  {data.staffOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Rate/h">
                <TextInput name="rate" required inputMode="decimal" />
              </Field>
              <Field label="From">
                <TextInput name="effective_from" type="date" required />
              </Field>
              <div className="col-span-4">
                <SubmitButton tone="quiet">Add override</SubmitButton>
              </div>
            </form>
          </Panel>

          <Panel title="Firm interest policy">
            <form action={saveInterestPolicyAction} className="flex max-w-md items-end gap-2">
              <div className="w-28">
                <Field label="% per year">
                  <TextInput name="annual_rate" required inputMode="decimal" />
                </Field>
              </div>
              <div className="w-28">
                <Field label="Grace days">
                  <TextInput name="grace_days" required inputMode="numeric" />
                </Field>
              </div>
              <div className="pb-3">
                <SubmitButton tone="quiet">Save (supersedes)</SubmitButton>
              </div>
            </form>
            <p className="mt-1 text-xs text-neutral-400">
              A bill charges interest only at the rate STATED ON IT at issue — changing the policy
              never touches issued bills.
            </p>
          </Panel>
        </div>

        <div>
          <Panel title={<span>Cost rates {data.seesCostRates ? <Badge tone="violet">cleared</Badge> : <Badge tone="neutral">hidden</Badge>}</span>}>
            {data.seesCostRates ? (
              <>
                <DataTable
                  headers={['Staff', 'Cost/h', 'From']}
                  rows={data.costRates.map((r) => [
                    String((r.person_name as { family?: string })?.family ?? ''),
                    Number(r.rate).toFixed(2),
                    fmtDate(r.effective_from),
                  ])}
                  emptyState="No cost rates — profitability reports omit cost where none covers the period."
                />
                <form action={addCostRateAction} className="mt-3 grid max-w-md grid-cols-3 items-end gap-2">
                  <Field label="Staff">
                    <Select name="staff">
                      {data.staffOptions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Cost/h">
                    <TextInput name="rate" required inputMode="decimal" />
                  </Field>
                  <Field label="From">
                    <TextInput name="effective_from" type="date" required />
                  </Field>
                  <div className="col-span-3">
                    <SubmitButton tone="quiet">Add cost rate</SubmitButton>
                  </div>
                </form>
              </>
            ) : (
              <p className="text-sm text-neutral-500">
                Cost rates are row-secured — this tab shows nothing without see_cost_rates.
              </p>
            )}
          </Panel>

          <Panel title="Cost types (disbursement defaults)">
            <DataTable
              headers={['Name', 'Default amount', 'State', '']}
              rows={data.costTypes.map((c) => [
                String(c.name),
                c.default_amount === null ? '—' : Number(c.default_amount).toFixed(2),
                c.active ? <Badge key="a" tone="green">active</Badge> : <Badge key="a">inactive</Badge>,
                c.active ? (
                  <InlineAction
                    key="d"
                    action={deactivateCostTypeAction}
                    fields={{ cost_type: c.id as number }}
                    label="Deactivate"
                  />
                ) : (
                  ''
                ),
              ])}
              emptyState="No cost types."
            />
            <form action={addCostTypeAction} className="mt-3 grid max-w-md grid-cols-2 items-end gap-2">
              <Field label="Name">
                <TextInput name="name" required />
              </Field>
              <Field label="Default amount" hint="Optional">
                <TextInput name="default_amount" inputMode="decimal" />
              </Field>
              <div className="col-span-2">
                <SubmitButton tone="quiet">Add cost type</SubmitButton>
              </div>
            </form>
          </Panel>
        </div>
      </div>
    </Page>
  )
}
