// The bill approval queue: groups pending approval, decided as one
// unit by bill.approve holders — open the editor to approve-and-issue or
// send back.

import { requirePrincipal } from '@/lib/auth'
import { billApprovalQueue } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, RowLink, fmtDateTime } from '@/components/ui'
import { readParams, type SearchParams } from '@/lib/screens/action'

export default async function BillApprovalsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await billApprovalQueue(p)
  return (
    <Page
      title="Bill approvals"
      lead="Draft bills submitted for a second pair of eyes. Sibling bills for the same work are decided together — open one to review its lines, send it back, or issue."
    >
      <Notices searchParams={sp} />
      <Panel>
        <DataTable
          headers={['Draft', 'Matter', 'Total', 'Siblings', 'Submitted by', 'Waiting since']}
          rows={rows.map((r) => [
            <RowLink key="g" href={`/billing/drafts/${r.group_id}`}>
              #{String(r.group_id)}
            </RowLink>,
            <RowLink key="m" href={`/matters/${r.matter}`}>
              {String(r.matter_number)} — {String(r.title)}
            </RowLink>,
            Number(r.matter_total).toFixed(2),
            String(r.siblings),
            String((r.submitter_name as { given?: string; family?: string })?.family ?? ''),
            fmtDateTime(r.submitted_at),
          ])}
          emptyState="Nothing awaiting approval."
        />
      </Panel>
    </Page>
  )
}
