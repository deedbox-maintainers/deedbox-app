// Sign-in history: per-user for self; firm-wide for administrators.

import { requirePrincipal, viewerContext } from '@/lib/auth'
import { signInHistory } from '@/lib/reads/security'
import { Page, Panel, DataTable, Badge, fmtDateTime, personName } from '@/components/ui'
import { readParams, type SearchParams } from '@/lib/screens/action'

export default async function SignInHistoryPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const viewer = await viewerContext(p)
  const admin = viewer.capabilities.has('security.administer')
  const all = admin && sp.scope !== 'mine'
  const rows = await signInHistory(p, { allStaff: all })
  return (
    <Page
      title="Sign-in history"
      lead={all ? 'Every sign-in, step-up and session end across the firm.' : 'Your sign-ins, step-ups and session ends.'}
      actions={
        admin ? (
          <a className="text-sm text-sky-700 hover:underline" href={all ? '?scope=mine' : '?scope=all'}>
            {all ? 'Show mine only' : 'Show all staff'}
          </a>
        ) : null
      }
    >
      <Panel>
        <DataTable
          headers={['When', 'Event', 'Person', 'Detail']}
          emptyState="No sign-in activity in this range."
          rows={rows.map((r) => [
            fmtDateTime(r.occurred_at),
            <Badge
              key="k"
              tone={
                r.event_kind === 'signin.succeeded'
                  ? 'green'
                  : r.event_kind === 'session.ended'
                    ? 'neutral'
                    : r.event_kind === 'signin.step_up'
                      ? 'blue'
                      : 'red'
              }
            >
              {r.event_kind}
            </Badge>,
            r.actor_kind === 'staff' ? personName(r.actor_name) : r.actor_kind,
            <span key="d" className="text-xs text-neutral-500">
              {JSON.stringify(r.detail)}
            </span>,
          ])}
        />
      </Panel>
    </Page>
  )
}
