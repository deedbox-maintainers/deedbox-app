// A held-funds run: the itemisation (executable / awaiting a different
// authoriser / refused with reasons), commit, and per-item decisions.

import { requirePrincipal } from '@/lib/auth'
import { heldFundsRunDetail, billingViewerFlags } from '@/lib/reads/billing'
import { bankFileAvailableFor } from '@/lib/ops/billing/aba'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { TextInput, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { commitHeldFundsAction, authoriseItemAction, abandonHeldFundsAction } from '../../actions'

export default async function HeldFundsRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const [d, flags, bankFile] = await Promise.all([
    heldFundsRunDetail(p, Number(id)),
    billingViewerFlags(p),
    bankFileAvailableFor(p),
  ])
  const previewed = d.run.state === 'previewed'

  return (
    <Page
      title={`Held-funds run #${String(d.run.id)}`}
      lead={`${String(d.run.scope).replace('_', ' ')} · ${fmtDateTime(d.run.run_at)} by ${String((d.run.run_by_name as { family?: string })?.family ?? '')} · ${String(d.run.state).replace(/_/g, ' ')}.`}
    >
      <Notices searchParams={sp} />
      {bankFile && d.items.some((i) => i.item_state === 'completed') ? (
        <p className="mb-3 text-sm">
          <a href={`/billing/held-funds/${String(d.run.id)}/aba`} className="text-sky-700 underline">
            Download the bank payment file
          </a>{' '}
          <span className="text-neutral-500">
            — one credit to the firm account for the completed transfers; key it into the bank as-is.
          </span>
        </p>
      ) : null}
      <Panel title="Items">
        <DataTable
          headers={['Bill', 'Matter', 'Amount', 'State', 'Decide']}
          rows={d.items.map((i) => [
            <RowLink key="b" href={`/billing/bills/${i.bill}`}>
              {String(i.bill_number ?? `#${i.bill}`)}
            </RowLink>,
            String(i.matter_number),
            Number(i.amount).toFixed(2),
            <span key="s">
              <Badge
                tone={
                  i.item_state === 'completed'
                    ? 'green'
                    : i.item_state === 'refused'
                      ? 'red'
                      : i.item_state === 'awaiting_authorisation'
                        ? 'amber'
                        : 'blue'
                }
              >
                {String(i.item_state).replace(/_/g, ' ')}
              </Badge>
              {i.refusal_reason ? <span className="ml-1 text-neutral-500">{String(i.refusal_reason)}</span> : null}
            </span>,
            i.item_state === 'awaiting_authorisation' && flags.authorisePayment ? (
              <div key="d" className="space-y-1">
                <InlineAction
                  action={authoriseItemAction}
                  fields={{ run: d.run.id as number, item: i.id as number, decision: 'approve' }}
                  label="Approve — executes the whole transfer"
                  tone="primary"
                />
                <form action={authoriseItemAction} className="flex items-center gap-1">
                  <input type="hidden" name="run" value={d.run.id as number} />
                  <input type="hidden" name="item" value={i.id as number} />
                  <input type="hidden" name="decision" value="reject" />
                  <TextInput name="note" placeholder="Reject — reason" className="!w-36" />
                  <SubmitButton tone="quiet">Reject</SubmitButton>
                </form>
              </div>
            ) : (
              ''
            ),
          ])}
          emptyState="No items — the preview found nothing executable."
        />
        <p className="mt-2 text-xs text-neutral-400">
          The requester never authorises their own item. An approval completes the whole
          two-world transfer in one act; a refusal is captured with the payment blocked, never
          silently dropped.
        </p>
      </Panel>
      {previewed ? (
        <Panel title="Commit">
          <div className="flex items-center gap-4">
            <InlineAction
              action={commitHeldFundsAction}
              fields={{ run: d.run.id as number }}
              label="Commit — items park for authorisation"
              tone="danger"
            />
            <InlineAction action={abandonHeldFundsAction} fields={{ run: d.run.id as number }} label="Abandon" />
          </div>
        </Panel>
      ) : null}
    </Page>
  )
}
