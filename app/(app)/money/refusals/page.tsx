// The refusal register: every captured refusal — reason, ledger, actor,
// payload — permanent and never editable. Rows on invisible matters are
// absent by the predicate. Promotion to an incident happens exactly once.

import { requirePrincipal } from '@/lib/auth'
import { refusalRegister } from '@/lib/reads/money'
import { Page, Panel, Notices, RowLink, Badge, EmptyState, fmtDateTime } from '@/components/ui'
import { TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { promoteRefusalAction } from '../actions'

export default async function RefusalsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await refusalRegister(p)

  return (
    <Page
      title="Refused operations"
      lead="Every money operation a guard stopped — recorded in its own act so the attempt survives the rollback. This register is evidence: nothing here can ever be edited or deleted."
    >
      <Notices searchParams={sp} />
      <Panel>
        {rows.length === 0 ? (
          <EmptyState>No refused operations — the exception register is clean.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={r.id as number} className="rounded-md border border-neutral-200 p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge tone="red">{String(r.refusal_reason).replace(/_/g, ' ')}</Badge>
                  <span className="text-neutral-500">
                    {fmtDateTime(r.at)} · {String(r.account_name)}
                    {r.ledger_number ? ` · ${r.ledger_number}` : ''}
                    {r.matter_number ? ` · ${r.matter_number}` : ''}
                    {' · by '}
                    {r.attempted_by_kind === 'staff'
                      ? String((r.attempted_by_name as { family?: string })?.family ?? r.attempted_by)
                      : String(r.attempted_by_kind)}
                  </span>
                  {r.promoted_incident ? (
                    <RowLink href="/money/incidents">
                      <Badge tone="amber">promoted to incident #{String(r.promoted_incident)}</Badge>
                    </RowLink>
                  ) : null}
                </div>
                <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-xs text-neutral-600">
                  {JSON.stringify(r.attempted_operation, null, 1)}
                </pre>
                {!r.promoted_incident ? (
                  <form action={promoteRefusalAction} className="mt-2 flex items-center gap-1">
                    <input type="hidden" name="refusal" value={r.id as number} />
                    <TextInput name="narrative" placeholder="Promote to incident — narrative" className="!w-72" />
                    <SubmitButton tone="quiet">Promote</SubmitButton>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Page>
  )
}
