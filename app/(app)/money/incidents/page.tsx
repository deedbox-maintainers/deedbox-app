// The incident register: deficiency incidents by state, rectification
// naming the correcting transactions, and the report action storing the
// notification artefact.

import { requirePrincipal } from '@/lib/auth'
import { incidentRegister } from '@/lib/reads/money'
import { Page, Panel, Notices, Badge, EmptyState, fmtDate } from '@/components/ui'
import { TextInput, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { rectifyIncidentAction, reportIncidentAction } from '../actions'

export default async function IncidentsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await incidentRegister(p)

  return (
    <Page
      title="Deficiency incidents"
      lead="Where client money was — or would have been — short: promoted refusals, reconciliation findings, manual records. Rectification names the correcting transactions; reporting stores the notification permanently."
    >
      <Notices searchParams={sp} />
      <Panel>
        {rows.length === 0 ? (
          <EmptyState>No deficiency incidents.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {rows.map((i) => (
              <li key={i.id as number} className="rounded-md border border-neutral-200 p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge tone={i.state === 'open' ? 'red' : i.state === 'rectified' ? 'amber' : 'green'}>
                    {String(i.state)}
                  </Badge>
                  <span className="font-medium tabular-nums">{Number(i.amount).toFixed(2)}</span>
                  <span className="text-neutral-500">
                    {fmtDate(i.incident_date)} · {String(i.account_name)}
                    {i.ledger_number ? ` · ${i.ledger_number}` : ''} · origin {String(i.origin).replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="mb-1 text-neutral-800">
                  <strong>Cause:</strong> {String(i.cause)} — {String(i.narrative)}
                </p>
                {i.rectification ? (
                  <p className="mb-1 text-xs text-neutral-500">
                    Rectified: {JSON.stringify(i.rectification)}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <form action={rectifyIncidentAction} className="flex items-center gap-1">
                    <input type="hidden" name="incident" value={i.id as number} />
                    <TextInput name="transactions" placeholder="Correcting txn #s" className="!w-36" />
                    <TextInput name="note" placeholder="Note" className="!w-40" />
                    <SubmitButton tone="quiet">Rectify</SubmitButton>
                  </form>
                  {i.state !== 'reported' ? (
                    <InlineAction
                      action={reportIncidentAction}
                      fields={{ incident: i.id as number }}
                      label="Generate the notification"
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Page>
  )
}
