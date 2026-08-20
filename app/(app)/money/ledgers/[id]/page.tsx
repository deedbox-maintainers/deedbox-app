// The ledger screen: the full line history in entry order with running
// balances, each line's transaction context, reversal pairs linked,
// printable via the browser.

import { requirePrincipal } from '@/lib/auth'
import { ledgerScreen } from '@/lib/reads/money'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDate } from '@/components/ui'
import { TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { reverseTransactionAction } from '../../actions'

export default async function LedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const d = await ledgerScreen(p, Number(id), { before: sp.before ? Number(sp.before) : undefined })
  const l = d.ledger

  return (
    <Page
      title={`Ledger ${String(l.ledger_number)}`}
      actions={
        <a
          href={`/money/ledgers/${l.id}/pdf`}
          className="rounded-md bg-[var(--brand-primary,#171717)] px-3 py-1.5 text-sm text-white hover:opacity-90 print:hidden"
        >
          Download PDF
        </a>
      }
      lead={
        <span className="flex flex-wrap items-center gap-2">
          <span>{String(l.account_name)}</span>
          {l.matter ? (
            <RowLink href={`/matters/${l.matter}/money`}>
              {String(l.matter_number)} — {String(l.title)}
            </RowLink>
          ) : (
            <Badge tone="violet">{String(l.ledger_kind).replace(/_/g, ' ')}</Badge>
          )}
          <Badge tone={l.status === 'open' ? 'green' : 'neutral'}>{String(l.status)}</Badge>
          <span>
            balance <strong className="tabular-nums">{Number(l.balance).toFixed(2)}</strong>
          </span>
        </span>
      }
    >
      <Notices searchParams={sp} />
      <Panel title="Every entry, in order">
        <DataTable
          headers={['#', 'Date', 'What', 'By', 'Amount', 'Balance', '']}
          rows={d.lines.map((ll) => [
            String(ll.entry_no),
            fmtDate(ll.effective_date),
            <span key="k">
              {String(ll.txn_kind).replace(/_/g, ' ')}
              {ll.reverses ? <Badge tone="amber"> reversal of txn #{String(ll.reverses)}</Badge> : null}
              {ll.reason ? <span className="text-neutral-400"> · {String(ll.reason)}</span> : null}
              <span className="text-neutral-300"> · {String(ll.source_type)} #{String(ll.source)}</span>
            </span>,
            String((ll.entered_by_name as { family?: string })?.family ?? ''),
            <span key="a" className={`tabular-nums ${Number(ll.signed_amount) < 0 ? 'text-red-700' : ''}`}>
              {Number(ll.signed_amount).toFixed(2)}
            </span>,
            <span key="b" className="tabular-nums">{Number(ll.running_balance).toFixed(2)}</span>,
            !ll.reverses ? (
              <details key="rv">
                <summary className="cursor-pointer text-xs text-sky-700">Reverse</summary>
                <form action={reverseTransactionAction} className="mt-1 flex items-center gap-1">
                  <input type="hidden" name="ledger" value={l.id as number} />
                  <input type="hidden" name="transaction" value={ll.txn as number} />
                  <TextInput name="reason" placeholder="Reason (recorded)" className="!w-36" />
                  <TextInput name="authorisation" placeholder="Auth # if kind demands" className="!w-32" />
                  <SubmitButton tone="quiet">Reverse whole txn</SubmitButton>
                </form>
              </details>
            ) : (
              ''
            ),
          ])}
          emptyState="No entries."
        />
        {d.lines.length === 100 ? (
          <form method="get" className="mt-3">
            <input type="hidden" name="before" value={String(d.lines[d.lines.length - 1].entry_no)} />
            <SubmitButton tone="quiet">Older entries</SubmitButton>
          </form>
        ) : null}
      </Panel>
    </Page>
  )
}
