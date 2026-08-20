// Examiner grants: grants with state, window, examined period, per-grant
// read activity, revoke with reason. The one-time secret shows once in the
// grant notice and is never retrievable.

import { requirePrincipal } from '@/lib/auth'
import { examinerGrantsScreen } from '@/lib/reads/security'
import { Page, Panel, DataTable, Badge, Notices, fmtDate, fmtDateTime } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { grantExaminerAction, revokeExaminerAction } from '../actions'

export default async function ExaminersPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const grants = await examinerGrantsScreen(p)
  return (
    <Page
      title="Examiner access"
      lead="Time-boxed, read-only access for an external examiner: money records within the examined period, under a minimal identity header. Every read is registered."
    >
      <Notices searchParams={sp} />
      <Panel title="Grants">
        <DataTable
          headers={['Examiner', 'Login', 'Examined period', 'Access window', 'State', 'Reads', 'Revoke (reason required)']}
          emptyState="No examiner access has been granted."
          rows={grants.map((g) => [
            g.examiner_name,
            g.login,
            `${fmtDate(g.period_start)} – ${fmtDate(g.period_end)}`,
            `${fmtDateTime(g.starts_at)} – ${fmtDateTime(g.expires_at)}`,
            g.revoked_at ? (
              <Badge tone="red">revoked</Badge>
            ) : new Date(String(g.expires_at)) < new Date() ? (
              <Badge tone="neutral">expired</Badge>
            ) : (
              <Badge tone="green">
                current{g.active_sessions ? ` · ${g.active_sessions} session(s)` : ''}
              </Badge>
            ),
            String(g.reads),
            g.revoked_at ? null : (
              <form action={revokeExaminerAction} className="flex items-center gap-2">
                <input type="hidden" name="grant" value={g.id} />
                <TextInput name="reason" placeholder="Reason" required className="w-40" />
                <SubmitButton tone="danger">Revoke</SubmitButton>
              </form>
            ),
          ])}
        />
      </Panel>
      <Panel title="Grant access">
        <form action={grantExaminerAction} className="grid max-w-2xl grid-cols-2 gap-x-4">
          <Field label="Examiner name">
            <TextInput name="examiner_name" required />
          </Field>
          <Field label="Examiner login">
            <TextInput name="login" required />
          </Field>
          <Field label="Examined period from">
            <TextInput name="period_start" type="date" required />
          </Field>
          <Field label="Examined period to">
            <TextInput name="period_end" type="date" required />
          </Field>
          <Field label="Access opens">
            <TextInput name="starts_at" type="datetime-local" required />
          </Field>
          <Field label="Access closes">
            <TextInput name="expires_at" type="datetime-local" required />
          </Field>
          <div>
            <SubmitButton>Grant</SubmitButton>
          </div>
          <p className="col-span-2 text-xs text-neutral-400">
            The sign-in secret is shown exactly once, in the confirmation after granting.
          </p>
        </form>
      </Panel>
    </Page>
  )
}
