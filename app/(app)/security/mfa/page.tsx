// MFA enrolment view: staff in MFA-required roles who have not enrolled.

import { requirePrincipal } from '@/lib/auth'
import { mfaEnrolmentGaps } from '@/lib/reads/security'
import { Page, Panel, DataTable, personName } from '@/components/ui'

export default async function MfaPage() {
  const p = await requirePrincipal()
  const { scope, staff } = await mfaEnrolmentGaps(p)
  return (
    <Page
      title="MFA enrolment"
      lead={
        scope === 'off'
          ? 'The policy does not require a second factor — nothing to chase.'
          : 'Staff the policy requires to enrol a second factor who have not yet done so.'
      }
    >
      <Panel>
        <DataTable
          headers={['Name', 'Login', 'Role']}
          emptyState="Everyone required to enrol has enrolled."
          rows={staff.map((s) => [personName(s.person_name), s.login, s.role_name])}
        />
      </Panel>
    </Page>
  )
}
