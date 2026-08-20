// Firm-accounts settings: the enable ceremony, opening
// balances, month locks, bank rules.

import { requirePrincipal } from '@/lib/auth'
import { glSettingsPanel } from '@/lib/reads/gl'
import { Page, Panel, Badge, Notices, DataTable, fmtDate } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { enableGlAction, lockMonthAction, openingBalancesAction, createRuleAction } from '../actions'

export default async function GlSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const panel = await glSettingsPanel(p)
  const accounts = panel.accounts as Record<string, unknown>[]
  return (
    <Page title="Books settings" lead="Switching on seeds a starter chart; the conversion date is where these books begin; locked months never reopen.">
      <Notices searchParams={sp} />

      <Panel title={panel.config.enabled ? 'Module: ON' : 'Module: OFF'}>
        <form action={enableGlAction} className="flex flex-wrap items-end gap-2">
          <Field label="Books begin (conversion date)">
            <TextInput
              name="conversion_date"
              type="date"
              required
              defaultValue={panel.config.conversionDate ?? ''}
            />
          </Field>
          <SubmitButton>{panel.config.enabled ? 'Update' : 'Switch on'}</SubmitButton>
        </form>
      </Panel>

      {panel.config.enabled ? (
        <>
          <Panel title="Opening balances">
            {panel.openingJournal ? (
              <p className="text-sm text-neutral-600">
                Posted as <Badge tone="green">{panel.openingJournal}</Badge>. Reverse that journal
                if they were wrong, then post again.
              </p>
            ) : (
              <form action={openingBalancesAction} className="max-w-2xl">
                <Field label="As at"><TextInput name="as_of" type="date" required /></Field>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-neutral-500">
                      <th className="py-1">Account</th><th>Debit</th><th>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <tr key={i}>
                        <td className="py-1 pr-2">
                          <Select name={`ob_${i}_account`} defaultValue="">
                            <option value="">—</option>
                            {accounts.map((a) => (
                              <option key={a.id as number} value={a.id as number}>
                                {a.code as string} {a.name as string}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="pr-2"><TextInput name={`ob_${i}_debit`} placeholder="0.00" className="w-28" /></td>
                        <td><TextInput name={`ob_${i}_credit`} placeholder="0.00" className="w-28" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mb-2 mt-1 text-xs text-neutral-400">
                  Any difference lands on the opening-balance-equity account automatically.
                </p>
                <SubmitButton tone="quiet">Post opening balances</SubmitButton>
              </form>
            )}
          </Panel>

          <Panel title="Period locks">
            <DataTable
              headers={['From', 'To', 'Status']}
              rows={(panel.periods as Record<string, unknown>[]).map((r) => [
                fmtDate(r.period_start),
                fmtDate(r.period_end),
                r.status as string,
              ])}
              emptyState="No locks yet."
            />
            <form action={lockMonthAction} className="mt-2 flex items-end gap-2">
              <Field label="Lock month"><TextInput name="month" type="month" required /></Field>
              <SubmitButton tone="danger">Lock — this never reopens</SubmitButton>
            </form>
          </Panel>

          <Panel title="Bank rules">
            <DataTable
              headers={['Name', 'Matches', 'Direction', 'Action', 'Account', 'Auto']}
              rows={(panel.rules as Record<string, unknown>[]).map((r) => [
                r.name as string,
                [r.match_desc_op && r.match_desc ? `description ${r.match_desc_op} "${r.match_desc}"` : null,
                 r.match_ref ? `reference has "${r.match_ref}"` : null]
                  .filter(Boolean)
                  .join('; ') || 'any',
                r.match_direction as string,
                r.action as string,
                (r.account_code as string | null) ?? '—',
                r.auto_post ? 'yes' : 'suggest',
              ])}
              emptyState="No rules yet."
            />
            <form action={createRuleAction} className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="Name"><TextInput name="name" required className="w-44" /></Field>
              <Field label="Description">
                <Select name="match_desc_op" defaultValue="contains">
                  <option value="contains">contains</option>
                  <option value="equals">equals</option>
                </Select>
              </Field>
              <Field label="Text"><TextInput name="match_desc" className="w-40" /></Field>
              <Field label="Direction">
                <Select name="direction" defaultValue="any">
                  <option value="any">any</option><option value="in">in</option><option value="out">out</option>
                </Select>
              </Field>
              <Field label="Action">
                <Select name="action" defaultValue="suggest_only">
                  <option value="suggest_only">suggest only</option>
                  <option value="receive_money">receive</option>
                  <option value="spend_money">spend</option>
                </Select>
              </Field>
              <Field label="Account">
                <Select name="account" defaultValue="">
                  <option value="">—</option>
                  {accounts.map((a) => (
                    <option key={a.id as number} value={a.id as number}>
                      {a.code as string} {a.name as string}
                    </option>
                  ))}
                </Select>
              </Field>
              <Checkbox name="auto_post" label="post automatically" />
              <SubmitButton tone="quiet">Add rule</SubmitButton>
            </form>
          </Panel>
        </>
      ) : null}
    </Page>
  )
}
