// Matter work-in-progress + estimate & budget panel: unbilled work with age
// bands, the estimate bar with its revision history, budgets, funds policy,
// payer shares, the billing-hold banner, and the draft-bill launcher. Every
// figure of record is the books' — this screen captures and launches.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { matterWip, matterBills, timeCaptureOptions, taxTreatmentOptions } from '@/lib/reads/billing'
import { Page, Panel, DataTable, DetailList, Notices, RowLink, Badge, EmptyState, fmtDate, fmtDateTime } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton, InlineAction, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  addMatterTimeEntry,
  addDisbursementAction,
  writeOffItemAction,
  editTimeEntryAction,
  removeUnbilledItemAction,
  reviseEstimateAction,
  setBudgetAction,
  setFundsPolicyAction,
  replacePayersAction,
  placeHoldAction,
  releaseHoldAction,
  createDraftAction,
  abandonDraftAction,
} from '../../../billing/actions'

export default async function MatterBillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const [wip, capture, bills, taxOptions] = await Promise.all([
    matterWip(p, Number(id)),
    timeCaptureOptions(p),
    matterBills(p, Number(id)),
    taxTreatmentOptions(p),
  ])
  const m = wip.matter
  // the tools below pick entries by DESCRIPTION — never by an internal number
  const wipEntryOptions = [
    ...wip.time.map((t) => ({
      v: `time_entry:${t.id}`,
      label: `Time · ${fmtDate(t.work_date)} — ${String(t.narrative).slice(0, 40)} — $${Number(t.value).toFixed(2)}`,
    })),
    ...wip.disbursements.map((d) => ({
      v: `disbursement:${d.id}`,
      label: `Disb · ${fmtDate(d.incurred_date)} — ${String(d.description).slice(0, 40)} — $${Number(d.amount).toFixed(2)}`,
    })),
  ]
  const est = wip.estimate
  const estimateAmount = est ? Number(est.current_amount) : null
  const consumed = wip.consumption.unbilled + wip.consumption.billed
  const pct = estimateAmount && estimateAmount > 0 ? Math.min(200, Math.round((consumed / estimateAmount) * 100)) : null

  return (
    <Page
      title={`Billing — ${m.matter_number}`}
      lead={
        <span>
          {m.title} — <RowLink href={`/matters/${m.id}`}>back to the matter</RowLink>
        </span>
      }
    >
      <Notices searchParams={sp} />

      {wip.openHold ? (
        <div className="mb-4 flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>
            <strong>Billing hold:</strong> {String(wip.openHold.reason)} (placed{' '}
            {fmtDateTime(wip.openHold.placed_at)} by {String((wip.openHold.placed_by_name as { family?: string })?.family ?? '')})
            — runs skip this matter; direct issue stays available deliberately.
          </span>
          <InlineAction
            action={releaseHoldAction}
            fields={{ matter: m.id, hold: wip.openHold.id as number }}
            label="Release"
          />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <div>
          <Panel title="Unbilled work">
            {wip.time.length === 0 && wip.disbursements.length === 0 ? (
              <EmptyState>No unbilled work.</EmptyState>
            ) : (
              <form action={createDraftAction}>
                <input type="hidden" name="matter" value={m.id} />
                <h3 className="mb-1 text-sm font-medium text-neutral-700">Time</h3>
                <DataTable
                  headers={['', 'Date', 'Who', 'Narrative', 'Value', 'Age']}
                  rows={wip.time.map((t) => [
                    <input key="cb" type="checkbox" name="time_entries" value={t.id as number} defaultChecked className="h-4 w-4" />,
                    fmtDate(t.work_date),
                    String((t.staff_name as { family?: string })?.family ?? ''),
                    String(t.narrative),
                    Number(t.value).toFixed(2),
                    <Badge key="a" tone={t.age_band === '0–30' ? 'neutral' : 'amber'}>{String(t.age_band)}</Badge>,
                  ])}
                  emptyState="No unbilled time."
                />
                <h3 className="mb-1 mt-4 text-sm font-medium text-neutral-700">Disbursements</h3>
                <DataTable
                  headers={['', 'Date', 'Description', 'Amount', 'Age']}
                  rows={wip.disbursements.map((d) => [
                    <input key="cb" type="checkbox" name="disbursements" value={d.id as number} defaultChecked className="h-4 w-4" />,
                    fmtDate(d.incurred_date),
                    String(d.description),
                    Number(d.amount).toFixed(2),
                    <Badge key="a" tone={d.age_band === '0–30' ? 'neutral' : 'amber'}>{String(d.age_band)}</Badge>,
                  ])}
                  emptyState="No unbilled disbursements."
                />
                <div className="mt-3 border-t border-neutral-100 pt-3">
                  <SubmitButton>Draft a bill from the ticked items</SubmitButton>
                </div>
              </form>
            )}
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-sky-700">
                Record time / add a disbursement / write off / amend / remove an entry
              </summary>
              <div className="mt-3 grid grid-cols-1 gap-6 md:grid-cols-3">
                <form action={addMatterTimeEntry} className="max-w-xs">
                  <input type="hidden" name="matter" value={m.id} />
                  {capture.recordForOthers ? (
                    <Field label="Record for" hint="The fee earner whose time this is">
                      <Select name="staff" defaultValue="">
                        <option value="">Myself</option>
                        {capture.staffOptions
                          .filter((s) => s.id !== p.id)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                      </Select>
                    </Field>
                  ) : null}
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Date">
                      <TextInput name="work_date" type="date" required />
                    </Field>
                    <Field label="Type">
                      <Select name="kind" defaultValue="timed">
                        <option value="timed">Timed</option>
                        <option value="fixed_fee">Fixed fee</option>
                      </Select>
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Units" hint="Timed entries">
                      <TextInput name="units" inputMode="numeric" />
                    </Field>
                    <Field label="Fixed amount" hint="Fixed fee, tax excluded">
                      <TextInput name="fixed_amount" inputMode="decimal" />
                    </Field>
                  </div>
                  <Field label="Narrative">
                    <TextArea name="narrative" rows={2} required />
                  </Field>
                  <SubmitButton tone="quiet">Record time</SubmitButton>
                </form>
                <form action={addDisbursementAction} className="max-w-xs">
                  <input type="hidden" name="matter" value={m.id} />
                  <Field label="Date">
                    <TextInput name="incurred_date" type="date" required />
                  </Field>
                  <Field label="Description">
                    <TextInput name="description" required />
                  </Field>
                  {taxOptions.length > 0 ? (
                    <>
                      <Field label="Total (tax included)" hint="Type the supplier document's total — the tax is worked out for you">
                        <TextInput name="total_amount" inputMode="decimal" required />
                      </Field>
                      <Field label="Tax treatment" hint="The choices come from the firm's country pack">
                        <Select name="tax_treatment" defaultValue={(taxOptions.find((t) => t.isDefault) ?? taxOptions[0]).key}>
                          {taxOptions.map((t) => (
                            <option key={t.key} value={t.key}>{t.label}</option>
                          ))}
                        </Select>
                      </Field>
                    </>
                  ) : (
                    <Field label="Total" hint="No tax rule governs this installation — the total is recorded as typed">
                      <TextInput name="total_amount" inputMode="decimal" required />
                    </Field>
                  )}
                  <SubmitButton tone="quiet">Add disbursement</SubmitButton>
                </form>
                <form action={writeOffItemAction} className="max-w-xs">
                  <input type="hidden" name="matter" value={m.id} />
                  <Field label="Write off before billing" hint="Real work the firm has decided not to charge — permanent record">
                    <select name="entry" required className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm">
                      <option value="">Pick the entry…</option>
                      {wipEntryOptions.map((o) => (
                        <option key={o.v} value={o.v}>{o.label}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Reason (permanent record)">
                    <TextInput name="reason" required />
                  </Field>
                  <SubmitButton tone="quiet">Write off before billing</SubmitButton>
                </form>
                <form action={editTimeEntryAction} className="max-w-xs">
                  <input type="hidden" name="matter" value={m.id} />
                  <Field label="Amend a time entry" hint="Unbilled time only — leave a box blank to keep it as is">
                    <select name="entry" required className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm">
                      <option value="">Pick the entry…</option>
                      {wip.time.map((t) => (
                        <option key={String(t.id)} value={String(t.id)}>
                          {`${fmtDate(t.work_date)} — ${String(t.narrative).slice(0, 40)} — $${Number(t.value).toFixed(2)}`}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Units (6-minute)">
                    <TextInput name="units" inputMode="numeric" />
                  </Field>
                  <Field label="Narrative">
                    <TextInput name="narrative" />
                  </Field>
                  <Field label="Date">
                    <TextInput name="work_date" type="date" />
                  </Field>
                  <SubmitButton tone="quiet">Amend entry</SubmitButton>
                </form>
                <form action={removeUnbilledItemAction} className="max-w-xs">
                  <input type="hidden" name="matter" value={m.id} />
                  <Field label="Remove an incorrect entry" hint="Unbilled only — comes off the file and will not bill">
                    <select name="entry" required className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm">
                      <option value="">Pick the entry…</option>
                      {wipEntryOptions.map((o) => (
                        <option key={o.v} value={o.v}>{o.label}</option>
                      ))}
                    </select>
                  </Field>
                  <SubmitButton tone="quiet">Remove entry</SubmitButton>
                </form>
              </div>
            </details>
          </Panel>

          <Panel title="Open drafts">
            <DataTable
              headers={['Draft', 'Total', 'Siblings', 'State', '', '']}
              rows={wip.drafts.map((g) => [
                <RowLink key="g" href={`/billing/drafts/${g.id}`}>
                  #{String(g.id)}
                </RowLink>,
                Number(g.matter_total).toFixed(2),
                String(g.siblings),
                String(g.bill_state).replace(/_/g, ' '),
                '',
                <InlineAction
                  key="ab"
                  action={abandonDraftAction}
                  fields={{ matter: m.id, group: g.id as number }}
                  label="Abandon"
                />,
              ])}
              emptyState="No open drafts."
            />
          </Panel>

          <Panel title={`Issued bills (${bills.length})`}>
            <DataTable
              headers={['Bill', 'Issued', 'Due', 'Payer', 'Total', 'Outstanding']}
              rows={bills.map((b) => [
                <RowLink key="b" href={`/billing/bills/${b.id}`}>
                  {b.billNumber ?? `#${b.id}`}
                </RowLink>,
                fmtDate(b.issueDate),
                fmtDate(b.dueDate),
                b.payerName,
                <span key="t" className="tabular-nums">{b.issueTotal.toFixed(2)}</span>,
                <span key="o" className={`tabular-nums${b.outstanding > 0 ? ' font-medium' : ''}`}>
                  {b.outstanding.toFixed(2)}
                </span>,
              ])}
              emptyState="No bills have been issued on this matter."
            />
          </Panel>

          {!wip.openHold ? (
            <Panel title="Place a billing hold">
              <form action={placeHoldAction} className="flex max-w-md items-end gap-2">
                <input type="hidden" name="matter" value={m.id} />
                <div className="grow">
                  <Field label="Reason (always recorded)">
                    <TextInput name="reason" required />
                  </Field>
                </div>
                <div className="pb-3">
                  <SubmitButton tone="quiet">Place hold</SubmitButton>
                </div>
              </form>
            </Panel>
          ) : null}
        </div>

        <div>
          <Panel title="Estimate">
            {est ? (
              <>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-neutral-600">
                    Recorded + billed: <strong>{consumed.toFixed(2)}</strong> of{' '}
                    <strong>{estimateAmount!.toFixed(2)}</strong>
                  </span>
                  {pct !== null ? (
                    <Badge tone={pct >= 100 ? 'red' : pct >= 80 ? 'amber' : 'green'}>{pct}%</Badge>
                  ) : null}
                </div>
                {pct !== null ? (
                  <div className="mb-3 h-2 overflow-hidden rounded bg-neutral-100">
                    <div
                      className={`h-2 ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                ) : null}
                <p className="mb-2 text-xs text-neutral-400">
                  Display figures; the alerting thresholds are evaluated by the books at{' '}
                  {(est.alert_thresholds as number[]).join('% / ')}%.
                </p>
                <details>
                  <summary className="cursor-pointer text-sm text-sky-700">Revision history</summary>
                  <DataTable
                    headers={['Rev', 'Amount', 'When', 'By', 'Reason']}
                    rows={(est.revisions as { revisionNo: number; amount: number; revisedAt: string; author: string; reason: string }[]).map(
                      (r) => [String(r.revisionNo), Number(r.amount).toFixed(2), fmtDateTime(r.revisedAt), r.author, r.reason],
                    )}
                  />
                </details>
              </>
            ) : (
              <EmptyState>No estimate recorded yet.</EmptyState>
            )}
            <form action={reviseEstimateAction} className="mt-3 flex max-w-md items-end gap-2 border-t border-neutral-100 pt-3">
              <input type="hidden" name="matter" value={m.id} />
              <div className="w-32">
                <Field label={est ? 'Revise to' : 'Set estimate'}>
                  <TextInput name="amount" required inputMode="decimal" />
                </Field>
              </div>
              <div className="grow">
                <Field label="Reason">
                  <TextInput name="reason" required />
                </Field>
              </div>
              <div className="pb-3">
                <SubmitButton tone="quiet">{est ? 'Revise' : 'Set'}</SubmitButton>
              </div>
            </form>
          </Panel>

          <Panel title="Budgets">
            <DataTable
              headers={['Level', 'Amount', 'Spend so far']}
              rows={wip.budgets.map((b) => [
                String(b.level),
                Number(b.amount).toFixed(2),
                Number(b.spend).toFixed(2),
              ])}
              emptyState="No active budget."
            />
            <form action={setBudgetAction} className="mt-3 flex max-w-md items-end gap-2">
              <input type="hidden" name="matter" value={m.id} />
              <div className="w-32">
                <Field label="Budget amount">
                  <TextInput name="amount" required inputMode="decimal" />
                </Field>
              </div>
              <div className="pb-3">
                <SubmitButton tone="quiet">Set (supersedes)</SubmitButton>
              </div>
            </form>
            {wip.alerts.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-sky-700">Alert history</summary>
                <DataTable
                  headers={['What', 'Threshold', 'Fired']}
                  rows={wip.alerts.map((a) => [
                    String(a.subject_type).replace('_', ' '),
                    `${a.threshold_pct}%`,
                    fmtDateTime(a.fired_at),
                  ])}
                />
              </details>
            ) : null}
          </Panel>

          <Panel title="Money on hand policy">
            {wip.fundsPolicy ? (
              <DetailList
                items={[
                  ['Minimum before alert', Number(wip.fundsPolicy.minimum_threshold).toFixed(2)],
                  ['Top up to', Number(wip.fundsPolicy.target_amount).toFixed(2)],
                  ['Attach request to next bill', wip.fundsPolicy.attach_to_next_bill ? 'yes' : 'no'],
                  ['Issue automatically', wip.fundsPolicy.auto_issue ? 'yes' : 'no'],
                ]}
              />
            ) : (
              <EmptyState>No policy — no top-up requests are raised for this matter.</EmptyState>
            )}
            <form action={setFundsPolicyAction} className="mt-3 max-w-md border-t border-neutral-100 pt-3">
              <input type="hidden" name="matter" value={m.id} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Minimum">
                  <TextInput name="minimum" required inputMode="decimal" />
                </Field>
                <Field label="Target">
                  <TextInput name="target" required inputMode="decimal" />
                </Field>
              </div>
              <Checkbox name="attach" label="Attach the request to the next bill" />
              <Checkbox name="auto_issue" label="Issue requests automatically" />
              <SubmitButton tone="quiet">Save policy</SubmitButton>
            </form>
          </Panel>

          <Panel title="Who pays (future bills)">
            <DataTable
              headers={['Payer', 'Share %']}
              rows={wip.payers.map((x) => [String(x.display_name), String(x.share_pct)])}
              emptyState="The client pays 100% by default."
            />
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-sky-700">Replace the payer set</summary>
              <form action={replacePayersAction} className="mt-3 max-w-md">
                <input type="hidden" name="matter" value={m.id} />
                {[0, 1, 2].map((i) => (
                  <div key={i} className="grid grid-cols-2 gap-3">
                    <Field label={`Payer ${i + 1} (party #)`}>
                      <TextInput name="payer_party" inputMode="numeric" />
                    </Field>
                    <Field label="Share %">
                      <TextInput name="payer_share" inputMode="decimal" />
                    </Field>
                  </div>
                ))}
                <p className="mb-2 text-xs text-neutral-400">
                  Shares must sum to exactly 100. Issued bills keep their payers; this governs
                  future bill groups only.
                </p>
                <SubmitButton tone="quiet">Replace</SubmitButton>
              </form>
            </details>
          </Panel>

          <p className="text-sm text-neutral-500">
            <Link href={`/billing/held-funds?matter=${m.id}`} className="text-sky-700 hover:underline">
              Apply held client money to this matter's bills
            </Link>
          </p>
        </div>
      </div>
    </Page>
  )
}
