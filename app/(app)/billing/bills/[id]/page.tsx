// The issued-bill view: lines, the full journal history, outstanding,
// disputes, interest (statement, charges, proposals), reminder state and
// contacts, arrangement coverage, capability-gated attribution, credit and
// write-off actions, and the send ceremony — recipients shown,
// deliberate confirmation, no one-click send anywhere.

import { requirePrincipal } from '@/lib/auth'
import { billView, billingViewerFlags } from '@/lib/reads/billing'
import { previewBillSend } from '@/lib/ops/billing'
import { Page, Panel, DataTable, DetailList, Notices, RowLink, Badge, EmptyState, fmtDate, fmtDateTime } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, InlineAction, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  creditNoteAction,
  applyCreditAction,
  writeOffBillAction,
  applyBillHeldFundsAction,
  raiseDisputeAction,
  resolveDisputeAction,
  addInterestChargeAction,
  approveProposalAction,
  dismissProposalAction,
  holdReminderAction,
  releaseReminderAction,
  assignSequenceAction,
  replaceAttributionAction,
  sendBillAction,
  unallocateAction,
} from '../../actions'

const REMINDER_TONES: Record<string, 'green' | 'amber' | 'red' | 'neutral' | 'blue'> = {
  running: 'blue',
  stopped_paid: 'green',
  stopped_arrangement: 'neutral',
  stopped_disputed: 'amber',
  held_manual: 'amber',
  exhausted: 'red',
}

export default async function BillViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const [v, flags] = await Promise.all([billView(p, Number(id)), billingViewerFlags(p)])
  const b = v.bill
  const issued = b.state === 'issued'
  const sendPreview = issued && sp.send === '1' ? await previewBillSend(p, { bill: Number(id) }) : null

  return (
    <Page
      title={issued ? `Bill ${String(b.bill_number)}` : `Bill (draft) #${String(b.id)}`}
      lead={
        <span className="flex flex-wrap items-center gap-2">
          <RowLink href={`/matters/${b.matter}`}>{String(b.matter_number)}</RowLink>
          <span>· payer {String(b.payer_name)} ({String(b.share_pct)}%)</span>
          {issued ? (
            <span>
              · issued {fmtDate(b.issue_date)} · due {fmtDate(b.due_date)} · outstanding{' '}
              <strong className="tabular-nums">{Number(b.outstanding).toFixed(2)}</strong>
            </span>
          ) : null}
          {v.openDispute ? <Badge tone="amber">disputed</Badge> : null}
          {v.arrangement ? <Badge tone="blue">arrangement</Badge> : null}
        </span>
      }
      actions={
        issued ? (
          <a
            href={`/billing/bills/${b.id}?send=1`}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Send…
          </a>
        ) : undefined
      }
    >
      <Notices searchParams={sp} />

      {sendPreview ? (
        <Panel title="Send this bill — the ceremony">
          <p className="mb-2 text-sm text-neutral-600">
            {sendPreview.paymentDetailsComplete
              ? 'The payment details block is complete and renders with the details governing at despatch.'
              : 'The payment details block is INCOMPLETE — the bill will render without payment instructions until the firm details are finished.'}
          </p>
          <form action={sendBillAction} className="max-w-lg">
            <input type="hidden" name="bill" value={b.id as number} />
            <Field label="Recipients" hint="Email addresses, comma-separated — shown here deliberately; there is no one-click send">
              <TextInput name="recipients" required defaultValue={sendPreview.suggestedRecipient ?? ''} />
            </Field>
            <Checkbox name="confirmed" label="I have checked the recipients and the rendering" />
            <SubmitButton tone="danger">Send now</SubmitButton>
          </form>
        </Panel>
      ) : null}

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <div>
          <Panel title="Lines">
            <DataTable
              headers={['#', 'Description', 'Amount', 'Tax']}
              rows={v.lines.map((l) => [
                String(l.position),
                <span key="d">
                  {String(l.description)}
                  {l.written_down_to !== null ? <Badge tone="amber"> written down</Badge> : null}
                </span>,
                Number(l.amount).toFixed(2),
                Number(l.tax_amount).toFixed(2),
              ])}
            />
          </Panel>

          <Panel title="Journal — every movement, in order">
            <DataTable
              headers={['#', 'What', 'Amount', 'Date', 'By', '']}
              rows={v.journal.map((j) => [
                String(j.entry_no),
                <span key="k">
                  {String(j.entry_kind).replace(/_/g, ' ')}
                  {j.reason ? <span className="text-neutral-400"> · {String(j.reason)}</span> : null}
                </span>,
                Number(j.signed_amount).toFixed(2),
                fmtDate(j.effective_date),
                String((j.entered_by_name as { family?: string })?.family ?? 'system'),
                j.entry_kind === 'payment_allocation' && !j.reversed && flags.issue ? (
                  <details key="ua">
                    <summary className="cursor-pointer text-xs text-sky-700">Unallocate</summary>
                    <form action={unallocateAction} className="mt-1 flex items-center gap-1">
                      <input type="hidden" name="bill" value={b.id as number} />
                      <input type="hidden" name="allocation_entry" value={j.id as number} />
                      <TextInput name="reason" placeholder="Reason" className="!w-32" />
                      <SubmitButton tone="quiet">Reverse</SubmitButton>
                    </form>
                  </details>
                ) : (
                  ''
                ),
              ])}
              emptyState="No journal entries yet."
            />
          </Panel>

          {issued ? (
            <Panel title="Credits & write-off">
              {v.credits.length > 0 ? (
                <DataTable
                  headers={['Credit', 'Amount', 'Remainder', 'Apply']}
                  rows={v.credits.map((c) => [
                    String(c.credit_number),
                    Number(c.amount).toFixed(2),
                    Number(c.remainder).toFixed(2),
                    Number(c.remainder) > 0 ? (
                      <form key="ap" action={applyCreditAction} className="flex items-center gap-1">
                        <input type="hidden" name="bill" value={b.id as number} />
                        <input type="hidden" name="note" value={c.id as number} />
                        <TextInput name="amount" placeholder="Amount" inputMode="decimal" className="!w-24" />
                        <SubmitButton tone="quiet">Apply</SubmitButton>
                      </form>
                    ) : (
                      '—'
                    ),
                  ])}
                />
              ) : null}
              <form action={applyBillHeldFundsAction} className="mt-3 border-b border-neutral-100 pb-4">
                <input type="hidden" name="bill" value={b.id as number} />
                <Field
                  label="Pay from held client money"
                  hint="Prepares a trust-to-office transfer for this bill — capped at what is owed and what the matter holds. Nothing moves until it is approved on the client-money payments screen."
                >
                  <SubmitButton tone="quiet">Prepare the transfer</SubmitButton>
                </Field>
              </form>
              <div className="mt-3 grid grid-cols-1 gap-6 md:grid-cols-2">
                <form action={creditNoteAction}>
                  <input type="hidden" name="bill" value={b.id as number} />
                  <Field label="Credit note amount">
                    <TextInput name="amount" required inputMode="decimal" />
                  </Field>
                  <Field label="Reason">
                    <TextInput name="reason" required />
                  </Field>
                  <SubmitButton tone="quiet">Issue credit note</SubmitButton>
                </form>
                <form action={writeOffBillAction}>
                  <input type="hidden" name="bill" value={b.id as number} />
                  <Field label="Write off amount" hint="Capped at the outstanding balance">
                    <TextInput name="amount" required inputMode="decimal" />
                  </Field>
                  <Field label="Reason">
                    <TextInput name="reason" required />
                  </Field>
                  <SubmitButton tone="quiet">Write off</SubmitButton>
                </form>
              </div>
            </Panel>
          ) : null}
        </div>

        <div>
          {issued ? (
            <Panel title="Reminders">
              {v.reminder ? (
                <>
                  <DetailList
                    items={[
                      [
                        'State',
                        <Badge key="s" tone={REMINDER_TONES[String(v.reminder.status)] ?? 'neutral'}>
                          {String(v.reminder.status).replace(/_/g, ' ')}
                        </Badge>,
                      ],
                      ['Sequence', String(v.reminder.sequence_name)],
                      ['Step reached', String(v.reminder.current_step_no)],
                      ['Next step', v.reminder.next_step_at ? fmtDateTime(v.reminder.next_step_at) : '—'],
                      ...(v.reminder.hold_reason ? [['Held because', String(v.reminder.hold_reason)] as [string, string]] : []),
                    ]}
                  />
                  <div className="mt-3 flex flex-wrap items-end gap-4">
                    {v.reminder.status === 'held_manual' ? (
                      <InlineAction action={releaseReminderAction} fields={{ bill: b.id as number }} label="Release" />
                    ) : v.reminder.status === 'running' ? (
                      <form action={holdReminderAction} className="flex items-end gap-2">
                        <input type="hidden" name="bill" value={b.id as number} />
                        <div className="w-48">
                          <Field label="Hold — reason">
                            <TextInput name="reason" required />
                          </Field>
                        </div>
                        <div className="pb-3">
                          <SubmitButton tone="quiet">Hold</SubmitButton>
                        </div>
                      </form>
                    ) : null}
                    {flags.remindersManage ? (
                      <form action={assignSequenceAction} className="flex items-end gap-2">
                        <input type="hidden" name="bill" value={b.id as number} />
                        <div className="w-44">
                          <Field label="Assign sequence">
                            <Select name="sequence">
                              {v.sequences.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                        </div>
                        <div className="pb-3">
                          <SubmitButton tone="quiet">Assign</SubmitButton>
                        </div>
                      </form>
                    ) : null}
                  </div>
                </>
              ) : (
                <EmptyState>No reminder sequence — assign one, or none applies to this bill.</EmptyState>
              )}
              {v.contacts.length > 0 ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-sky-700">Contact history</summary>
                  <DataTable
                    headers={['Step', 'Channel', 'Sent']}
                    rows={v.contacts.map((c) => [String(c.step_no), String(c.channel), fmtDateTime(c.sent_at)])}
                  />
                </details>
              ) : null}
            </Panel>
          ) : null}

          {issued ? (
            <Panel title="Disputes">
              {v.disputes.length === 0 ? (
                <EmptyState>No disputes.</EmptyState>
              ) : (
                <ul className="space-y-2 text-sm">
                  {v.disputes.map((d) => (
                    <li key={d.id as number} className="rounded-md border border-neutral-100 p-2">
                      <p className="text-neutral-800">{String(d.detail)}</p>
                      <p className="text-xs text-neutral-400">
                        raised {fmtDateTime(d.raised_at)}
                        {d.resolved_at ? ` · resolved: ${String(d.resolution_note)}` : ''}
                      </p>
                      {!d.resolved_at ? (
                        <form action={resolveDisputeAction} className="mt-2 flex items-center gap-1">
                          <input type="hidden" name="bill" value={b.id as number} />
                          <input type="hidden" name="dispute" value={d.id as number} />
                          <TextInput name="resolution_note" placeholder="Resolution note" className="!w-56" />
                          <SubmitButton tone="quiet">Resolve</SubmitButton>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {!v.openDispute ? (
                <form action={raiseDisputeAction} className="mt-3 flex items-end gap-2">
                  <input type="hidden" name="bill" value={b.id as number} />
                  <div className="grow">
                    <Field label="Raise a dispute — what the client says">
                      <TextInput name="detail" required />
                    </Field>
                  </div>
                  <div className="pb-3">
                    <SubmitButton tone="quiet">Raise</SubmitButton>
                  </div>
                </form>
              ) : null}
            </Panel>
          ) : null}

          {issued ? (
            <Panel title="Interest">
              {b.interest_statement ? (
                <p className="mb-2 text-sm text-neutral-600">
                  Stated on the bill:{' '}
                  {JSON.stringify(b.interest_statement) === 'null'
                    ? '—'
                    : `${(b.interest_statement as { annual_rate_pct?: number }).annual_rate_pct}% p.a. after ${(b.interest_statement as { grace_days?: number }).grace_days} days' grace`}
                </p>
              ) : (
                <p className="mb-2 text-sm text-neutral-500">
                  No interest statement on this bill — none can ever be charged on it.
                </p>
              )}
              {v.interestProposals.length > 0 ? (
                <DataTable
                  headers={['Period', 'Amount', 'State', '', '']}
                  rows={v.interestProposals.map((pr) => [
                    `${fmtDate(pr.period_from)} – ${fmtDate(pr.period_to)}`,
                    Number(pr.amount).toFixed(2),
                    <Badge key="s" tone={pr.state === 'pending' ? 'amber' : 'neutral'}>
                      {String(pr.state)}
                    </Badge>,
                    pr.state === 'pending' ? (
                      <InlineAction
                        key="ap"
                        action={approveProposalAction}
                        fields={{ bill: b.id as number, proposal: pr.id as number }}
                        label="Approve (recomputes at posting)"
                      />
                    ) : (
                      ''
                    ),
                    pr.state === 'pending' ? (
                      <form key="dm" action={dismissProposalAction} className="flex items-center gap-1">
                        <input type="hidden" name="bill" value={b.id as number} />
                        <input type="hidden" name="proposal" value={pr.id as number} />
                        <TextInput name="reason" placeholder="Reason" className="!w-28" />
                        <SubmitButton tone="quiet">Dismiss</SubmitButton>
                      </form>
                    ) : (
                      ''
                    ),
                  ])}
                />
              ) : null}
              {b.interest_statement ? (
                <div className="mt-2">
                  <InlineAction
                    action={addInterestChargeAction}
                    fields={{ bill: b.id as number }}
                    label="Charge interest now (at the bill's stated rate)"
                  />
                </div>
              ) : null}
            </Panel>
          ) : null}

          {v.arrangement ? (
            <Panel title="Arrangement">
              <DetailList
                items={[
                  ['State', String(v.arrangement.state)],
                  ['Instalment', Number(v.arrangement.instalment_amount).toFixed(2)],
                  ['Progress', `${v.arrangement.paid} of ${v.arrangement.instalment_count} paid`],
                  ['More', <RowLink key="l" href="/billing/arrangements">the arrangements screen</RowLink>],
                ]}
              />
            </Panel>
          ) : null}

          {v.attribution ? (
            <Panel title="Attribution (who gets credit for this bill)">
              <DataTable
                headers={['Staff', 'Share']}
                rows={v.attribution.map((a) => [
                  String((a.person_name as { family?: string })?.family ?? ''),
                  Number(a.billed_share).toFixed(2),
                ])}
                emptyState="Default attribution from the bill's lines."
              />
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-sky-700">Replace the whole set</summary>
                <form action={replaceAttributionAction} className="mt-2 max-w-sm">
                  <input type="hidden" name="bill" value={b.id as number} />
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="grid grid-cols-2 gap-2">
                      <Field label={`Staff # (${i + 1})`}>
                        <TextInput name="attr_staff" inputMode="numeric" />
                      </Field>
                      <Field label="Amount">
                        <TextInput name="attr_amount" inputMode="decimal" />
                      </Field>
                    </div>
                  ))}
                  <p className="mb-2 text-xs text-neutral-400">Must sum to the issue total exactly. Past collections stand.</p>
                  <SubmitButton tone="quiet">Replace</SubmitButton>
                </form>
              </details>
            </Panel>
          ) : null}
        </div>
      </div>
    </Page>
  )
}
