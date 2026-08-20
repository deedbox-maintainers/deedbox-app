// Staff detail: role, office, start date, MFA state, deactivate and
// reactivate with the guard explanations inline.

import { requirePrincipal } from '@/lib/auth'
import { staffDetail } from '@/lib/reads/security'
import { Page, Panel, DetailList, Badge, Notices, fmtDate, personName } from '@/components/ui'
import { Field, Select, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { changeRole, deactivate, reactivate } from '../../actions'

export default async function StaffDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const { staff, roles } = await staffDetail(p, Number(id))
  return (
    <Page title={personName(staff.person_name)}>
      <Notices searchParams={sp} />
      <Panel title="Account">
        <DetailList
          items={[
            ['Login', staff.login],
            ['Email', staff.email],
            ['Role', staff.role_name],
            ['Office', staff.office_name],
            ['Started', fmtDate(staff.start_date)],
            [
              'State',
              staff.active ? <Badge tone="green">active</Badge> : <Badge tone="red">inactive</Badge>,
            ],
            [
              'MFA',
              staff.mfa_enrolled ? (
                <span>
                  <Badge tone="blue">enrolled</Badge> {staff.factors} factor(s)
                </span>
              ) : (
                'not enrolled'
              ),
            ],
            ['Active sessions', String(staff.active_sessions)],
          ]}
        />
      </Panel>
      <Panel title="Change role" >
        <p className="mb-3 text-sm text-neutral-500">
          Takes effect immediately — nothing about permissions is cached. The change is refused if
          it would leave the firm without an administrator, or strand a restricted matter without
          an active guardian who can manage restrictions.
        </p>
        <form action={changeRole} className="flex max-w-md items-end gap-3">
          <input type="hidden" name="staff" value={staff.id} />
          <div className="grow">
            <Field label="New role">
              <Select name="role" defaultValue={staff.role}>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="pb-3">
            <SubmitButton>Change</SubmitButton>
          </div>
        </form>
      </Panel>
      <Panel title={staff.active ? 'Deactivate' : 'Reactivate'}>
        {staff.active ? (
          <>
            <p className="mb-3 text-sm text-neutral-500">
              Deactivation ends every session this person holds, in the same act. It is refused if
              they are the last active administrator or the last guardian of any restricted matter.
            </p>
            <InlineAction action={deactivate} fields={{ staff: staff.id }} label="Deactivate" tone="danger" />
          </>
        ) : (
          <>
            <p className="mb-3 text-sm text-neutral-500">Reactivation restores sign-in for this account.</p>
            <InlineAction action={reactivate} fields={{ staff: staff.id }} label="Reactivate" />
          </>
        )}
      </Panel>
    </Page>
  )
}
