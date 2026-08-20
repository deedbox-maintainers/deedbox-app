// Security policy screen: the auth policy in force, the four session
// settings (changed on the firm settings screen), and the change history.

import { requirePrincipal } from '@/lib/auth'
import { securityPolicy } from '@/lib/reads/security'
import { Page, Panel, DetailList, Notices, fmtDateTime, fmtJson } from '@/components/ui'
import { Field, Select, SubmitButton, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { savePolicy } from '../actions'

export default async function PolicyPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const { policy, settings, roles, history } = await securityPolicy(p)
  const scope = policy?.mfa_scope ?? 'off'
  const mfaRoles: number[] = (policy?.mfa_roles as number[] | null) ?? []
  return (
    <Page title="Security policy" lead="Authentication rules for everyone at the firm.">
      <Notices searchParams={sp} />
      <Panel title="Policy">
        <form action={savePolicy} className="max-w-xl">
          <Field
            label="Second factor (MFA)"
            hint="Named roles: only the ticked roles must enrol. Everyone: all staff must enrol before signing in."
          >
            <Select name="mfa_scope" defaultValue={scope}>
              <option value="off">Off</option>
              <option value="named_roles">Required for named roles</option>
              <option value="all_users">Required for everyone</option>
            </Select>
          </Field>
          <fieldset className="mb-3 rounded-md border border-neutral-200 p-3">
            <legend className="px-1 text-xs font-medium text-neutral-500">Roles required to enrol (named-roles mode)</legend>
            {roles.map((r) => (
              <label key={r.id} className="mr-4 inline-flex items-center gap-1.5 text-sm text-neutral-700">
                <input
                  type="checkbox"
                  name="mfa_roles"
                  value={r.id}
                  defaultChecked={mfaRoles.includes(r.id as number)}
                  className="h-4 w-4"
                />
                {r.name}
              </label>
            ))}
          </fieldset>
          <Checkbox
            name="step_up_on_unrecognised"
            label="Demand verification when a sign-in comes from an unrecognised device or location"
            defaultChecked={policy?.step_up_on_unrecognised ?? true}
          />
          <Checkbox
            name="step_up_email_fallback"
            label="Allow a one-time email code as the verification fallback"
            defaultChecked={policy?.step_up_email_fallback ?? true}
          />
          <SubmitButton>Save policy</SubmitButton>
        </form>
      </Panel>
      <Panel title="Session windows (from firm settings)">
        <DetailList
          items={[
            ['Idle timeout', `${fmtJson(settings['auth.session_idle_minutes'])} minutes`],
            ['Absolute lifetime', `${fmtJson(settings['auth.session_absolute_hours'])} hours`],
            ['Device trust after verification', `${fmtJson(settings['auth.device_trust_days'])} days`],
            ['Step-up freshness for dual control', `${fmtJson(settings['auth.step_up_freshness_minutes'])} minutes`],
          ]}
        />
      </Panel>
      <Panel title="Change history">
        {history.length === 0 ? (
          <p className="text-sm text-neutral-500">No changes recorded — the shipped defaults have always governed.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {history.map((h, i) => (
              <li key={i} className="text-neutral-600">
                {fmtDateTime(h.occurred_at)} — <code className="text-xs">{JSON.stringify(h.detail)}</code>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Page>
  )
}
