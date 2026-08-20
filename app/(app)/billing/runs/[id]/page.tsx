// A billing run's review: the honest filter snapshot (inclusions AND
// every exclusion with its reason), per-matter draft review with the
// client's name and held money beside each, issue-all — and once issued,
// paying the run's bills from held client money through the application
// ceremony, in one step.

import { requirePrincipal } from '@/lib/auth'
import { billingRunDetail } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { InlineAction, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { issueRunAction, abandonRunAction, applyRunHeldFundsAction } from '../../actions'

export default async function BillingRunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const d = await billingRunDetail(p, Number(id))
  const snapshot = d.run.filter_snapshot as {
    excluded?: { matter: number; reason: string }[]
    exclusions?: { matter: number; reason: string }[]
    issue_stopped?: { group: number; position: number; reason: string }
    issue_failures?: { group: number; reason: string }[]
  }
  // the snapshot's key is `excluded` (runs.ts); `exclusions` read older runs
  const excluded = snapshot.excluded ?? snapshot.exclusions ?? []
  const issueFailures =
    snapshot.issue_failures ?? (snapshot.issue_stopped ? [snapshot.issue_stopped] : [])
  const inReview = d.run.state === 'building' || d.run.state === 'in_review'
  const payable = d.payable.filter((b) => Number(b.held_available) > 0)

  return (
    <Page
      title={`Billing run #${String(d.run.id)}`}
      lead={`Built ${fmtDateTime(d.run.run_at)} by ${String((d.run.run_by_name as { family?: string })?.family ?? '')} — ${String(d.run.state).replace('_', ' ')}.${
        (d.run.filter_snapshot as { filters?: { throughDate?: string } } | null)?.filters?.throughDate
          ? ` Work dated on or before ${String((d.run.filter_snapshot as { filters: { throughDate: string } }).filters.throughDate)}.`
          : ''
      }`}
    >
      <Notices searchParams={sp} />

      <Panel title={`Drafted matters (${d.groups.length})`}>
        <DataTable
          headers={['Draft', 'Matter', 'Client', 'Total', 'Held money available', 'State']}
          rows={d.groups.map((g) => [
            <RowLink key="g" href={`/billing/drafts/${g.id}`}>
              #{String(g.id)}
            </RowLink>,
            <RowLink key="m" href={`/matters/${g.matter}`}>
              {String(g.matter_number)} — {String(g.title)}
            </RowLink>,
            String(g.client_name || '—'),
            Number(g.matter_total).toFixed(2),
            <span key="h" className="tabular-nums">{Number(g.held_available).toFixed(2)}</span>,
            <Badge key="s" tone={g.state === 'issued' ? 'green' : 'blue'}>
              {String(g.state)}
            </Badge>,
          ])}
          emptyState="Nothing drafted — every candidate was excluded (see below)."
        />
      </Panel>

      {excluded.length > 0 ? (
        <Panel title={`Excluded, with reasons (${excluded.length})`}>
          <DataTable
            headers={['Matter', 'Why']}
            rows={excluded.map((e) => [
              <RowLink key="m" href={`/matters/${e.matter}`}>
                #{e.matter}
              </RowLink>,
              e.reason,
            ])}
          />
        </Panel>
      ) : null}

      {issueFailures.length > 0 ? (
        <Panel title="Issue failures recorded on the run">
          <DataTable
            headers={['Draft', 'Why']}
            rows={issueFailures.map((f) => [String(f.group), f.reason])}
          />
        </Panel>
      ) : null}

      {inReview && d.groups.length > 0 ? (
        <Panel title="Issue">
          <div className="flex items-center gap-4">
            <InlineAction
              action={issueRunAction}
              fields={{ run: d.run.id as number }}
              label={`Issue all ${d.groups.filter((g) => g.state === 'draft').length} draft(s)`}
              tone="danger"
            />
            <InlineAction action={abandonRunAction} fields={{ run: d.run.id as number }} label="Abandon the run" />
          </div>
          <p className="mt-2 text-xs text-neutral-400">
            Each matter issues in its own transaction; the first hard failure stops the iteration
            and is recorded on the run. Already-issued bills stand.
          </p>
        </Panel>
      ) : null}

      {payable.length > 0 ? (
        <Panel title={`Pay from held client money (${payable.length} bill(s) with money held)`}>
          <form action={applyRunHeldFundsAction}>
            <input type="hidden" name="run" value={d.run.id as number} />
            <DataTable
              headers={['Pay?', 'Bill', 'Matter', 'Client', 'Owing', 'Held money available']}
              rows={payable.map((b) => [
                <input
                  key="t"
                  type="checkbox"
                  name="bill"
                  value={b.bill as number}
                  defaultChecked
                  className="h-4 w-4"
                  aria-label={`Pay ${String(b.bill_number)} from held money`}
                />,
                String(b.bill_number),
                String(b.matter_number),
                String(b.client_name || '—'),
                <span key="o" className="tabular-nums">{Number(b.outstanding).toFixed(2)}</span>,
                <span key="h" className="tabular-nums">{Number(b.held_available).toFixed(2)}</span>,
              ])}
            />
            <div className="mt-3">
              <SubmitButton>Prepare the transfers for the ticked bills</SubmitButton>
            </div>
            <p className="mt-2 text-xs text-neutral-400">
              Nothing moves yet: each ticked bill gets a transfer prepared for the money
              authorisation queue (capped at what is owed and what is held available). Approving a
              transfer there is what moves the money and marks the bill paid.
            </p>
          </form>
        </Panel>
      ) : null}
    </Page>
  )
}
