// My account: the signed-in person's own devices and sessions, with
// revoke and end actions, and their Microsoft 365 connection.

import { requirePrincipal } from '@/lib/auth'
import { myM365Connection } from '@/lib/reads/m365'
import { m365Service } from '@/lib/ops/m365'
import { myDevicesAndSessions } from '@/lib/reads/security'
import { Page, Panel, DataTable, Badge, Notices, fmtDateTime } from '@/components/ui'
import { InlineAction, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { disconnectM365Action, endOwnSession, revokeOwnDevice } from './actions'

export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const m365 = await myM365Connection(p)
  let m365ConsentUrl: string | null = null
  try {
    m365ConsentUrl = m365Service().consentUrl('connect')
  } catch {
    m365ConsentUrl = null
  }
  const sp = await readParams(searchParams)
  const { devices, sessions } = await myDevicesAndSessions(p)
  const active = sessions.filter((s) => s.ended_at === null)
  const past = sessions.filter((s) => s.ended_at !== null)
  return (
    <Page title="My devices & sessions">
      <Notices searchParams={sp} />
      <Panel title="Active sessions">
        <DataTable
          headers={['Started', 'Last seen', 'Device', 'Step-up', '']}
          emptyState="This is your only active session."
          rows={active.map((s) => [
            fmtDateTime(s.started_at),
            fmtDateTime(s.last_seen_at),
            String(s.device),
            s.step_up_required ? (
              <Badge tone="amber">awaiting verification</Badge>
            ) : s.step_up_passed ? (
              <Badge tone="green">verified</Badge>
            ) : (
              '—'
            ),
            s.id === p.session ? (
              <Badge tone="blue">this session</Badge>
            ) : (
              <InlineAction action={endOwnSession} fields={{ session: s.id }} label="End" />
            ),
          ])}
        />
      </Panel>
      <Panel title="Devices">
        <DataTable
          headers={['Label', 'First seen', 'Last seen', 'Network', 'Trusted', '']}
          emptyState="No devices recorded yet."
          rows={devices.map((d) => [
            d.label ?? d.fingerprint.slice(0, 12),
            fmtDateTime(d.first_seen),
            fmtDateTime(d.last_seen),
            d.network_hint ?? '—',
            d.revoked_at ? (
              <Badge tone="red">revoked</Badge>
            ) : d.trusted ? (
              <Badge tone="green">until {fmtDateTime(d.trust_expires_at)}</Badge>
            ) : (
              '—'
            ),
            d.revoked_at ? null : (
              <InlineAction action={revokeOwnDevice} fields={{ device: d.id }} label="Revoke" tone="danger" />
            ),
          ])}
        />
      </Panel>
      <Panel title="Recent sessions">
        <DataTable
          headers={['Started', 'Ended', 'Reason']}
          emptyState="No past sessions."
          rows={past.slice(0, 15).map((s) => [
            fmtDateTime(s.started_at),
            fmtDateTime(s.ended_at),
            s.end_reason ?? '—',
          ])}
        />
      </Panel>
    <Panel title="Microsoft 365">
        {m365.connected ? (
          <>
            <p>
              Connected as <strong>{m365.email}</strong>
              {m365.lastPolledAt ? ` — inbox last swept ${m365.lastPolledAt.slice(0, 16).replace('T', ' ')}` : ' — the first inbox sweep runs on the next poll'}
              . Inbox mail whose subject carries a matter number in square brackets files itself.
            </p>
            <form action={disconnectM365Action}>
              <SubmitButton tone="danger">Disconnect</SubmitButton>
            </form>
          </>
        ) : m365ConsentUrl ? (
          <p>
            <a href={m365ConsentUrl} className="text-sky-700 underline">
              Connect Microsoft 365
            </a>{' '}
            — send email from matters as yourself, and have tagged inbox mail filed automatically.
          </p>
        ) : (
          <p>Microsoft 365 is not configured on this installation.</p>
        )}
      </Panel>
    </Page>
  )
}
