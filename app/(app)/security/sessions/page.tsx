// All sessions (admin): every active session with end-one and end-all.

import { requirePrincipal } from '@/lib/auth'
import { allActiveSessions } from '@/lib/reads/security'
import { Page, Panel, DataTable, Badge, Notices, fmtDateTime, personName } from '@/components/ui'
import { InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { endAnySession, endAllFor } from '../actions'

export default async function AllSessionsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const sessions = await allActiveSessions(p)
  return (
    <Page title="All sessions" lead="Every active session. Ending one signs that person out of that device now.">
      <Notices searchParams={sp} />
      <Panel>
        <DataTable
          headers={['Person', 'Kind', 'Device', 'Started', 'Last seen', 'Step-up', '', '']}
          emptyState="No active sessions."
          rows={sessions.map((s) => [
            s.principal_kind === 'staff' ? personName(s.person_name) : `${s.principal_kind} #${s.principal}`,
            s.principal_kind,
            s.device_label ?? (s.fingerprint ? String(s.fingerprint).slice(0, 12) : s.device),
            fmtDateTime(s.started_at),
            fmtDateTime(s.last_seen_at),
            s.step_up_required ? (
              <Badge tone="amber">awaiting verification</Badge>
            ) : s.step_up_passed ? (
              <Badge tone="green">verified</Badge>
            ) : (
              '—'
            ),
            <InlineAction key="one" action={endAnySession} fields={{ session: s.id }} label="End" />,
            s.principal_kind === 'staff' ? (
              <InlineAction
                key="all"
                action={endAllFor}
                fields={{ staff: s.principal }}
                label="End all theirs"
                tone="danger"
              />
            ) : null,
          ])}
        />
      </Panel>
    </Page>
  )
}
