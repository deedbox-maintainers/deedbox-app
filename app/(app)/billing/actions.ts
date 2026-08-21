'use server'

// Billing-area server actions: parse → named operation → notice. Money and
// bill rules all live in lib/ops/billing; refusals surface in the operation's
// own words. Heavy commits carry no hidden re-derivation — what the screen
// showed is what the operation verifies.

import { act } from '@/lib/screens/action'
import { OperationRefused } from '@/lib/db'
import { recomputePositionCache } from '@/lib/ops/reports'
import {
  createTimeEntry,
  editTimeEntry,
  writeOffUnbilledItem,
  softDeleteUnbilledItem,
  startTimer,
  pauseTimer,
  resumeTimer,
  stopTimer,
  discardTimer,
  assignSuggestionMatter,
  acceptSuggestion,
  mergeSuggestion,
  discardSuggestion,
  createDisbursement,
  createCostType,
  deactivateCostType,
  reviseEstimate,
  setBudget,
  setFundsPolicy,
  replacePayerSet,
  createDraftBillGroup,
  removeDraftLine,
  writeDownDraftItem,
  addManualDraftLine,
  abandonDraftGroup,
  submitForApproval,
  sendBackToDraft,
  issueBillGroup,
  createBillingRun,
  issueBillingRun,
  abandonBillingRun,
  generateStatement,
  allocateStatementPayment,
  saveInterestPolicy,
  addInterestCharge,
  approveInterestProposal,
  dismissInterestProposal,
  createReminderSequence,
  holdReminder,
  releaseReminder,
  assignReminderSequence,
  createArrangement,
  reactivateArrangement,
  cancelArrangement,
  confirmTopUpRequest,
  cancelTopUpRequest,
  previewHeldFundsApplication,
  prepareFirmWideHeldFunds,
  commitHeldFundsApplication,
  authoriseHeldFundsItem,
  abandonHeldFundsRun,
  applyHeldFundsToRunBills,
  applyHeldFundsToBills,
  replaceBillAttribution,
  savePaymentDetails,
  approvePaymentDetails,
  sendBill,
  recordPayment,
  allocatePayment,
  unallocatePayment,
  correctPayment,
  createCreditNote,
  applyCredit,
  writeOffBill,
  raiseDispute,
  resolveDispute,
  placeBillingHold,
  releaseBillingHold,
  addStaffRate,
  addStaffCostRate,
  addMatterRateOverride,
} from '@/lib/ops/billing'
import { parse } from '@/components/forms'

// ---- time, timers, suggestions ---------------------------------------------

export async function addTimeEntry(formData: FormData): Promise<void> {
  await act('/billing', async (p) => {
    await createTimeEntry(p, {
      matter: parse.num(formData, 'matter'),
      staff: parse.numOrNull(formData, 'staff') ?? undefined,
      workDate: parse.str(formData, 'work_date'),
      kind: (parse.str(formData, 'kind') || 'timed') as 'timed' | 'fixed_fee',
      units: parse.numOrNull(formData, 'units') ?? undefined,
      fixedAmount: parse.numOrNull(formData, 'fixed_amount') ?? undefined,
      narrative: parse.str(formData, 'narrative'),
      category: parse.numOrNull(formData, 'category') ?? undefined,
      rateLabel: parse.strOrNull(formData, 'rate_label') ?? undefined,
    })
    return 'Time recorded.'
  })
}

export async function addMatterTimeEntry(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    await createTimeEntry(p, {
      matter,
      staff: parse.numOrNull(formData, 'staff') ?? undefined,
      workDate: parse.str(formData, 'work_date'),
      kind: (parse.str(formData, 'kind') || 'timed') as 'timed' | 'fixed_fee',
      units: parse.numOrNull(formData, 'units') ?? undefined,
      fixedAmount: parse.numOrNull(formData, 'fixed_amount') ?? undefined,
      narrative: parse.str(formData, 'narrative'),
    })
    return 'Time recorded.'
  })
}

export async function editTimeEntryAction(formData: FormData): Promise<void> {
  const matter = parse.numOrNull(formData, 'matter')
  await act(matter ? `/matters/${matter}/billing` : '/billing', async (p) => {
    await editTimeEntry(p, {
      entry: parse.num(formData, 'entry'),
      narrative: parse.strOrNull(formData, 'narrative') ?? undefined,
      units: parse.numOrNull(formData, 'units') ?? undefined,
      workDate: parse.strOrNull(formData, 'work_date') ?? undefined,
    })
    // the hub's cached position tiles refresh now, not at the nightly sweep
    await recomputePositionCache(p)
    return 'Entry updated.'
  })
}

// The billing tab's entry pickers submit one composite value, "kind:id" —
// the person chooses by description, never by an internal number.
function parseWipEntry(formData: FormData): { itemType: 'time_entry' | 'disbursement'; item: number } {
  const [kind, id] = parse.str(formData, 'entry').split(':')
  return { itemType: kind as 'time_entry' | 'disbursement', item: Number(id) }
}

export async function writeOffItemAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    await writeOffUnbilledItem(p, {
      ...parseWipEntry(formData),
      reason: parse.str(formData, 'reason'),
    })
    // the hub's cached position tiles refresh now, not at the nightly sweep
    await recomputePositionCache(p)
    return 'Written off before billing — permanent record kept.'
  })
}

export async function removeUnbilledItemAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    await softDeleteUnbilledItem(p, parseWipEntry(formData))
    // the hub's cached position tiles refresh now, not at the nightly sweep
    await recomputePositionCache(p)
    return 'Removed — the entry is off the file and will not bill.'
  })
}

export async function startTimerAction(formData: FormData): Promise<void> {
  await act('/billing', async (p) => {
    await startTimer(p, {
      matter: parse.numOrNull(formData, 'matter') ?? undefined,
      narrativeDraft: parse.strOrNull(formData, 'narrative') ?? undefined,
    })
    return 'Timer running.'
  })
}

export async function pauseTimerAction(formData: FormData): Promise<void> {
  await act('/billing', async (p) => {
    await pauseTimer(p, { timer: parse.num(formData, 'timer') })
    return 'Paused.'
  })
}

export async function resumeTimerAction(formData: FormData): Promise<void> {
  await act('/billing', async (p) => {
    await resumeTimer(p, { timer: parse.num(formData, 'timer') })
    return 'Running.'
  })
}

export async function stopTimerAction(formData: FormData): Promise<void> {
  await act('/billing', async (p) => {
    await stopTimer(p, {
      timer: parse.num(formData, 'timer'),
      matter: parse.numOrNull(formData, 'matter') ?? undefined,
      narrative: parse.strOrNull(formData, 'narrative') ?? undefined,
    })
    return 'Stopped — the time entry is recorded.'
  })
}

export async function discardTimerAction(formData: FormData): Promise<void> {
  await act('/billing', async (p) => {
    await discardTimer(p, { timer: parse.num(formData, 'timer') })
    return 'Timer discarded — nothing recorded.'
  })
}

export async function assignSuggestionAction(formData: FormData): Promise<void> {
  await act('/billing/suggestions', async (p) => {
    await assignSuggestionMatter(p, {
      suggestion: parse.num(formData, 'suggestion'),
      matter: parse.num(formData, 'matter'),
    })
    return 'Matter assigned — the suggestion is ready to accept.'
  })
}

export async function acceptSuggestionAction(formData: FormData): Promise<void> {
  await act('/billing/suggestions', async (p) => {
    await acceptSuggestion(p, {
      suggestion: parse.num(formData, 'suggestion'),
      units: parse.numOrNull(formData, 'units') ?? undefined,
      narrative: parse.strOrNull(formData, 'narrative') ?? undefined,
    })
    return 'Accepted — the time entry is recorded.'
  })
}

export async function mergeSuggestionAction(formData: FormData): Promise<void> {
  await act('/billing/suggestions', async (p) => {
    await mergeSuggestion(p, {
      suggestion: parse.num(formData, 'suggestion'),
      intoEntry: parse.num(formData, 'into_entry'),
    })
    return 'Merged into the existing entry.'
  })
}

export async function discardSuggestionAction(formData: FormData): Promise<void> {
  await act('/billing/suggestions', async (p) => {
    await discardSuggestion(p, { suggestion: parse.num(formData, 'suggestion') })
    return 'Discarded.'
  })
}

// ---- matter billing tab -----------------------------------------------------

export async function addDisbursementAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    // total-first entry: the person types the tax-inclusive total off the
    // supplier document; the operation derives the exclusive amount against
    // the pack's own rule so billing lands the same total to the cent
    await createDisbursement(p, {
      matter,
      incurredDate: parse.str(formData, 'incurred_date'),
      description: parse.strOrNull(formData, 'description') ?? undefined,
      inclusiveTotal: parse.numOrNull(formData, 'total_amount') ?? undefined,
      amount: parse.numOrNull(formData, 'amount') ?? undefined,
      // the choice is rendered FROM the pack's own declarations; absent =
      // the pack's declared default (resolved in the operation)
      taxTreatment: parse.strOrNull(formData, 'tax_treatment') ?? undefined,
      costType: parse.numOrNull(formData, 'cost_type') ?? undefined,
    })
    return 'Disbursement recorded.'
  })
}

export async function reviseEstimateAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    await reviseEstimate(p, {
      matter,
      amount: parse.num(formData, 'amount'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Estimate revised — the history keeps every figure.'
  })
}

export async function setBudgetAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    await setBudget(p, { matter, amount: parse.num(formData, 'amount') })
    return 'Budget set — it supersedes any earlier one.'
  })
}

export async function setFundsPolicyAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    await setFundsPolicy(p, {
      matter,
      minimumThreshold: parse.num(formData, 'minimum'),
      targetAmount: parse.num(formData, 'target'),
      attachToNextBill: parse.bool(formData, 'attach'),
      autoIssue: parse.bool(formData, 'auto_issue'),
    })
    return 'Money-on-hand policy saved.'
  })
}

export async function replacePayersAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    const parties = formData.getAll('payer_party').map(Number)
    const shares = formData.getAll('payer_share').map(Number)
    const payers = parties
      .map((party, i) => ({ party, sharePct: shares[i] }))
      .filter((x) => Number.isFinite(x.party) && x.party > 0 && Number.isFinite(x.sharePct))
    await replacePayerSet(p, { matter, payers })
    return 'Payer set replaced — future bills follow it; issued bills stand.'
  })
}

export async function placeHoldAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    await placeBillingHold(p, { matter, reason: parse.str(formData, 'reason') })
    return 'Billing hold placed.'
  })
}

export async function releaseHoldAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    await releaseBillingHold(p, { hold: parse.num(formData, 'hold') })
    return 'Hold released.'
  })
}

export async function createDraftAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    const timeEntries = formData.getAll('time_entries').map(Number).filter((n) => n > 0)
    const disbursements = formData.getAll('disbursements').map(Number).filter((n) => n > 0)
    const r = await createDraftBillGroup(p, {
      matter,
      timeEntries: timeEntries.length > 0 ? timeEntries : undefined,
      disbursements: disbursements.length > 0 ? disbursements : undefined,
    })
    return `goto:/billing/drafts/${r.group}?done=${encodeURIComponent('Draft created.')}`
  })
}

// ---- draft editor -----------------------------------------------------------

export async function removeLineAction(formData: FormData): Promise<void> {
  const group = parse.num(formData, 'group')
  await act(`/billing/drafts/${group}`, async (p) => {
    await removeDraftLine(p, { group, position: parse.num(formData, 'position') })
    return 'Line removed — the item is unbilled again.'
  })
}

export async function writeDownLineAction(formData: FormData): Promise<void> {
  const group = parse.num(formData, 'group')
  await act(`/billing/drafts/${group}`, async (p) => {
    await writeDownDraftItem(p, {
      group,
      position: parse.num(formData, 'position'),
      writtenDownTo: parse.num(formData, 'written_down_to'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Written down.'
  })
}

export async function addManualLineAction(formData: FormData): Promise<void> {
  const group = parse.num(formData, 'group')
  await act(`/billing/drafts/${group}`, async (p) => {
    await addManualDraftLine(p, {
      group,
      description: parse.str(formData, 'description'),
      amount: parse.num(formData, 'amount'),
    })
    return 'Line added.'
  })
}

export async function abandonDraftAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/billing`, async (p) => {
    await abandonDraftGroup(p, { group: parse.num(formData, 'group') })
    return 'Draft abandoned — every item is unbilled again.'
  })
}

export async function submitDraftAction(formData: FormData): Promise<void> {
  const group = parse.num(formData, 'group')
  await act(`/billing/drafts/${group}`, async (p) => {
    await submitForApproval(p, { group })
    return 'Submitted for approval.'
  })
}

export async function sendBackAction(formData: FormData): Promise<void> {
  const group = parse.num(formData, 'group')
  await act(`/billing/drafts/${group}`, async (p) => {
    await sendBackToDraft(p, { group, note: parse.strOrNull(formData, 'note') ?? undefined })
    return 'Sent back to draft.'
  })
}

export async function issueGroupAction(formData: FormData): Promise<void> {
  const group = parse.num(formData, 'group')
  await act(`/billing/drafts/${group}`, async (p) => {
    const r = await issueBillGroup(p, { group })
    const first = r.bills[0]
    return first
      ? `goto:/billing/bills/${first.id}?done=${encodeURIComponent(
          `Issued: ${r.bills.map((b) => b.billNumber).join(', ')}.`,
        )}`
      : 'Issued.'
  })
}

// ---- billing runs -----------------------------------------------------------

export async function createRunAction(formData: FormData): Promise<void> {
  await act('/billing/runs', async (p) => {
    // the preview's ticks: an explicit matter list — the run drafts exactly
    // what was chosen, nothing more (an empty tick-set is a refusal, never a
    // silent everything)
    const selected = parse.strOrNull(formData, 'selected') === '1'
    const matters = formData
      .getAll('m')
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0)
    if (selected && matters.length === 0) {
      throw new OperationRefused('nothing_ticked', 'tick at least one matter to bill')
    }
    const r = await createBillingRun(p, {
      filters: {
        practiceArea: parse.numOrNull(formData, 'practice_area') ?? undefined,
        office: parse.numOrNull(formData, 'office') ?? undefined,
        responsibleLawyer: parse.numOrNull(formData, 'lawyer') ?? undefined,
        throughDate: parse.strOrNull(formData, 'through_date') ?? undefined,
        matters: selected ? matters : undefined,
      },
    })
    return `goto:/billing/runs/${r.run}?done=${encodeURIComponent(
      `Run built: ${r.groups.length} matter(s) drafted, ${r.excluded.length} excluded with reasons.`,
    )}`
  })
}

export async function applyRunHeldFundsAction(formData: FormData): Promise<void> {
  const run = parse.num(formData, 'run')
  await act(`/billing/runs/${run}`, async (p) => {
    const bills = formData
      .getAll('bill')
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0)
    const r = await applyHeldFundsToRunBills(p, { run, bills })
    return `${r.awaiting} transfer(s) prepared and awaiting authorisation on the client-money payments screen (${r.matters} matter(s)${
      r.refused > 0 ? `, ${r.refused} refused with reasons recorded` : ''
    }). Approving each transfer is what moves the money.`
  })
}

export async function applyBillHeldFundsAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    const r = await applyHeldFundsToBills(p, { bills: [bill] })
    return `${r.awaiting} transfer(s) prepared and awaiting authorisation on the client-money payments screen. Approving the transfer is what moves the money.`
  })
}

export async function issueRunAction(formData: FormData): Promise<void> {
  const run = parse.num(formData, 'run')
  await act(`/billing/runs/${run}`, async (p) => {
    const r = await issueBillingRun(p, { run })
    return r.stoppedAt
      ? `Issued ${r.issued.length} group(s), then stopped at group #${r.stoppedAt.group}: ${r.stoppedAt.reason} (recorded on the run).`
      : `Issued ${r.issued.length} group(s).`
  })
}

export async function abandonRunAction(formData: FormData): Promise<void> {
  const run = parse.num(formData, 'run')
  await act(`/billing/runs/${run}`, async (p) => {
    await abandonBillingRun(p, { run })
    return 'Run abandoned — every draft released.'
  })
}

// ---- bill view --------------------------------------------------------------

export async function creditNoteAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    const r = await createCreditNote(p, {
      bill,
      amount: parse.num(formData, 'amount'),
      reason: parse.str(formData, 'reason'),
    })
    return `Credit note ${r.creditNumber} issued.`
  })
}

export async function applyCreditAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    await applyCredit(p, { note: parse.num(formData, 'note'), amount: parse.num(formData, 'amount') })
    return 'Credit applied.'
  })
}

export async function writeOffBillAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    await writeOffBill(p, { bill, amount: parse.num(formData, 'amount'), reason: parse.str(formData, 'reason') })
    return 'Written off — the permanent record and journal entry stand.'
  })
}

export async function raiseDisputeAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    await raiseDispute(p, { bill, detail: parse.str(formData, 'detail') })
    return 'Dispute raised — reminders stop automatically.'
  })
}

export async function resolveDisputeAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    await resolveDispute(p, {
      dispute: parse.num(formData, 'dispute'),
      resolutionNote: parse.str(formData, 'resolution_note'),
    })
    return 'Dispute resolved — reminders resume where appropriate.'
  })
}

export async function addInterestChargeAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    const r = await addInterestCharge(p, { bill })
    return `Interest charged: ${r.amount.toFixed(2)} for ${r.periodFrom} – ${r.periodTo}.`
  })
}

export async function approveProposalAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    const r = await approveInterestProposal(p, { proposal: parse.num(formData, 'proposal') })
    return r.posted
      ? `Approved — the recomputed charge (${r.amount.toFixed(2)}) is posted.`
      : `Nothing chargeable on recomputation — dismissed: ${r.dismissedReason}.`
  })
}

export async function dismissProposalAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    await dismissInterestProposal(p, {
      proposal: parse.num(formData, 'proposal'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Proposal dismissed.'
  })
}

export async function holdReminderAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    await holdReminder(p, { bill, reason: parse.str(formData, 'reason') })
    return 'Reminders held for this bill.'
  })
}

export async function releaseReminderAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    await releaseReminder(p, { bill })
    return 'Reminders released.'
  })
}

export async function assignSequenceAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    await assignReminderSequence(p, { bill, sequence: parse.num(formData, 'sequence') })
    return 'Sequence assigned.'
  })
}

export async function replaceAttributionAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    const staff = formData.getAll('attr_staff').map(Number)
    const amounts = formData.getAll('attr_amount').map(Number)
    const shares = staff
      .map((s, i) => ({ staff: s, amount: amounts[i] }))
      .filter((x) => x.staff > 0 && Number.isFinite(x.amount))
    await replaceBillAttribution(p, { bill, shares })
    return 'Attribution replaced — past collection fans stand.'
  })
}

export async function sendBillAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    const recipients = parse
      .str(formData, 'recipients')
      .split(/[,;\s]+/)
      .filter(Boolean)
    await sendBill(p, { bill, recipients, confirmed: parse.bool(formData, 'confirmed') })
    return 'Sent — the exact copy is stored with the send recorded.'
  })
}

// ---- payments ----------------------------------------------------------------

export async function recordPaymentAction(formData: FormData): Promise<void> {
  await act('/billing/payments', async (p) => {
    const bills = formData.getAll('alloc_bill').map(Number)
    const amounts = formData.getAll('alloc_amount').map(Number)
    const allocations = bills
      .map((bill, i) => ({ bill, amount: amounts[i] }))
      .filter((a) => a.bill > 0 && Number.isFinite(a.amount) && a.amount > 0)
    const r = await recordPayment(p, {
      payerParty: parse.numOrNull(formData, 'payer_party') ?? undefined,
      receivedDate: parse.str(formData, 'received_date'),
      amount: parse.num(formData, 'amount'),
      method: parse.str(formData, 'method'),
      reference: parse.strOrNull(formData, 'reference') ?? undefined,
      allocations: allocations.length > 0 ? allocations : undefined,
    })
    return `Receipt ${r.receiptNumber} recorded.`
  })
}

export async function allocatePaymentAction(formData: FormData): Promise<void> {
  await act('/billing/payments', async (p) => {
    const bills = formData.getAll('alloc_bill').map(Number)
    const amounts = formData.getAll('alloc_amount').map(Number)
    const allocations = bills
      .map((bill, i) => ({ bill, amount: amounts[i] }))
      .filter((a) => a.bill > 0 && Number.isFinite(a.amount) && a.amount > 0)
    await allocatePayment(p, { payment: parse.num(formData, 'payment'), allocations })
    return 'Allocated.'
  })
}

export async function unallocateAction(formData: FormData): Promise<void> {
  const bill = parse.num(formData, 'bill')
  await act(`/billing/bills/${bill}`, async (p) => {
    await unallocatePayment(p, {
      allocationEntry: parse.num(formData, 'allocation_entry'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Unallocated — exact reversal entries recorded.'
  })
}

export async function correctPaymentAction(formData: FormData): Promise<void> {
  await act('/billing/payments', async (p) => {
    await correctPayment(p, {
      payment: parse.num(formData, 'payment'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Payment corrected — the mirror reverses every open allocation.'
  })
}

// ---- statements · arrangements · top-ups -------------------------------------

export async function generateStatementAction(formData: FormData): Promise<void> {
  await act('/billing/statements', async (p) => {
    const r = await generateStatement(p, {
      scopeKind: parse.str(formData, 'scope_kind') as 'client' | 'matter',
      scope: parse.num(formData, 'scope'),
      withPaymentReference: parse.bool(formData, 'with_reference'),
    })
    return `Statement ${r.statementNumber} generated — ${r.totalOutstanding.toFixed(2)} outstanding.`
  })
}

export async function allocateStatementAction(formData: FormData): Promise<void> {
  await act('/billing/statements', async (p) => {
    const r = await allocateStatementPayment(p, {
      statement: parse.num(formData, 'statement'),
      payment: parse.num(formData, 'payment'),
    })
    const skips =
      r.skips.length > 0
        ? ` ${r.skips.length} skipped: ${r.skips.map((s) => `bill #${s.bill} (${s.reason})`).join('; ')}.`
        : ''
    return `Allocated across ${r.allocated.length} bill(s).${skips}`
  })
}

export async function createArrangementAction(formData: FormData): Promise<void> {
  await act('/billing/arrangements', async (p) => {
    const bills = parse
      .str(formData, 'bills')
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => n > 0)
    await createArrangement(p, {
      clientParty: parse.num(formData, 'client_party'),
      instalmentAmount: parse.num(formData, 'instalment_amount'),
      frequency: parse.str(formData, 'frequency') as 'weekly' | 'every_two_weeks' | 'monthly' | 'custom',
      customIntervalDays: parse.numOrNull(formData, 'custom_interval_days') ?? undefined,
      instalmentCount: parse.num(formData, 'instalment_count'),
      firstDueDate: parse.str(formData, 'first_due_date'),
      coversFutureBills: parse.bool(formData, 'covers_future'),
      bills,
    })
    return 'Arrangement created — covered reminders stop.'
  })
}

export async function reactivateArrangementAction(formData: FormData): Promise<void> {
  await act('/billing/arrangements', async (p) => {
    await reactivateArrangement(p, {
      arrangement: parse.num(formData, 'arrangement'),
      newFirstDueDate: parse.str(formData, 'new_first_due_date'),
    })
    return 'Reactivated — live instalments rescheduled, missed ones replaced.'
  })
}

export async function cancelArrangementAction(formData: FormData): Promise<void> {
  await act('/billing/arrangements', async (p) => {
    await cancelArrangement(p, {
      arrangement: parse.num(formData, 'arrangement'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Cancelled — reminders resume where bills stay unpaid.'
  })
}

export async function confirmTopUpAction(formData: FormData): Promise<void> {
  await act('/billing/top-ups', async (p) => {
    await confirmTopUpRequest(p, { request: parse.num(formData, 'request') })
    return 'Request issued — it now carries its payment reference.'
  })
}

export async function cancelTopUpAction(formData: FormData): Promise<void> {
  await act('/billing/top-ups', async (p) => {
    await cancelTopUpRequest(p, {
      request: parse.num(formData, 'request'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Request cancelled.'
  })
}

// ---- reminders config · held funds · rates · payment details -----------------

export async function createSequenceAction(formData: FormData): Promise<void> {
  await act('/billing/reminders', async (p) => {
    const stepNos = formData.getAll('step_no').map(Number)
    const days = formData.getAll('step_days').map(Number)
    const channels = formData.getAll('step_channel').map(String)
    const templates = formData.getAll('step_template').map(Number)
    const steps = stepNos
      .map((stepNo, i) => ({
        stepNo,
        daysAfterPrevious: days[i],
        channel: channels[i] as 'email' | 'text_message' | 'task',
        template: templates[i],
      }))
      .filter((s) => Number.isFinite(s.stepNo) && s.stepNo > 0 && s.template > 0)
    await createReminderSequence(p, {
      name: parse.str(formData, 'name'),
      defaultForNewBills: parse.bool(formData, 'default_for_new_bills'),
      steps,
    })
    return 'Sequence created.'
  })
}

export async function previewHeldFundsAction(formData: FormData): Promise<void> {
  await act('/billing/held-funds', async (p) => {
    const matter = parse.numOrNull(formData, 'matter')
    if (matter !== null) {
      const r = await previewHeldFundsApplication(p, { matter })
      return `goto:/billing/held-funds/${r.run}?done=${encodeURIComponent(
        `Preview ready: ${r.executable.length} executable, ${r.refused.length} refused with reasons. Nothing has moved.`,
      )}`
    }
    // blank = the firm-wide sweep: every issued bill still owing on a matter
    // holding available client money is found, its claim recorded, and the
    // run previewed — the run records exactly what it covered, and nothing
    // moves until the run commits and each transfer takes its authorisation
    const r = await prepareFirmWideHeldFunds(p)
    return `goto:/billing/held-funds/${r.run}?done=${encodeURIComponent(
      `Firm-wide sweep: ${r.executable} bill(s) can be paid from held money${
        r.refused > 0 ? `, ${r.refused} refused with reasons` : ''
      }. Nothing has moved — commit the run, then each transfer takes its authorisation.`,
    )}`
  })
}

export async function commitHeldFundsAction(formData: FormData): Promise<void> {
  const run = parse.num(formData, 'run')
  await act(`/billing/held-funds/${run}`, async (p) => {
    const r = await commitHeldFundsApplication(p, { run })
    return `Committed: ${r.awaiting.length} item(s) parked awaiting a different authoriser, ${r.refused.length} refused with reasons.`
  })
}

export async function authoriseItemAction(formData: FormData): Promise<void> {
  const run = parse.num(formData, 'run')
  await act(`/billing/held-funds/${run}`, async (p) => {
    await authoriseHeldFundsItem(p, {
      item: parse.num(formData, 'item'),
      decision: parse.str(formData, 'decision') as 'approve' | 'reject',
      note: parse.strOrNull(formData, 'note') ?? undefined,
    })
    return 'Decided.'
  })
}

export async function abandonHeldFundsAction(formData: FormData): Promise<void> {
  await act('/billing/held-funds', async (p) => {
    await abandonHeldFundsRun(p, { run: parse.num(formData, 'run') })
    return 'Run abandoned — nothing moved.'
  })
}

export async function addStaffRateAction(formData: FormData): Promise<void> {
  await act('/billing/rates', async (p) => {
    await addStaffRate(p, {
      staff: parse.num(formData, 'staff'),
      label: parse.strOrNull(formData, 'label') ?? undefined,
      rate: parse.num(formData, 'rate'),
      effectiveFrom: parse.str(formData, 'effective_from'),
    })
    return 'Rate added (append-only history).'
  })
}

export async function addCostRateAction(formData: FormData): Promise<void> {
  await act('/billing/rates', async (p) => {
    await addStaffCostRate(p, {
      staff: parse.num(formData, 'staff'),
      rate: parse.num(formData, 'rate'),
      effectiveFrom: parse.str(formData, 'effective_from'),
    })
    return 'Cost rate added.'
  })
}

export async function addOverrideAction(formData: FormData): Promise<void> {
  await act('/billing/rates', async (p) => {
    await addMatterRateOverride(p, {
      matter: parse.num(formData, 'matter'),
      staff: parse.numOrNull(formData, 'staff') ?? undefined,
      label: parse.strOrNull(formData, 'label') ?? undefined,
      rate: parse.num(formData, 'rate'),
      effectiveFrom: parse.str(formData, 'effective_from'),
    })
    return 'Override added.'
  })
}

export async function addCostTypeAction(formData: FormData): Promise<void> {
  await act('/billing/rates', async (p) => {
    await createCostType(p, {
      name: parse.str(formData, 'name'),
      defaultAmount: parse.numOrNull(formData, 'default_amount') ?? undefined,
      // absent = the pack's declared default (resolved in the operation)
      defaultTaxTreatment: parse.strOrNull(formData, 'default_tax') ?? undefined,
    })
    return 'Cost type created.'
  })
}

export async function deactivateCostTypeAction(formData: FormData): Promise<void> {
  await act('/billing/rates', async (p) => {
    await deactivateCostType(p, { costType: parse.num(formData, 'cost_type') })
    return 'Cost type deactivated.'
  })
}

export async function savePaymentDetailsAction(formData: FormData): Promise<void> {
  await act('/billing/payment-details', async (p) => {
    const keys = formData.getAll('id_key').map(String)
    const values = formData.getAll('id_value').map(String)
    const identifierValues: Record<string, string> = {}
    keys.forEach((k, i) => {
      if (k && values[i]) identifierValues[k] = values[i]
    })
    const r = await savePaymentDetails(p, {
      accountHolderName: parse.str(formData, 'account_holder_name'),
      bankName: parse.str(formData, 'bank_name'),
      identifierValues,
    })
    return r.state === 'pending'
      ? 'Saved as pending — a different authorised person must approve it; the prior details keep governing meanwhile.'
      : 'Saved and governing.'
  })
}

export async function approvePaymentDetailsAction(formData: FormData): Promise<void> {
  await act('/billing/payment-details', async (p) => {
    await approvePaymentDetails(p, { version: parse.num(formData, 'version') })
    return 'Approved — these details now govern every future despatch.'
  })
}

export async function saveInterestPolicyAction(formData: FormData): Promise<void> {
  await act('/billing/rates', async (p) => {
    await saveInterestPolicy(p, {
      scope: 'firm',
      annualRatePct: parse.num(formData, 'annual_rate'),
      graceDays: parse.num(formData, 'grace_days'),
    })
    return 'Interest policy saved (supersede-only history).'
  })
}
