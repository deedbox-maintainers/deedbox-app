'use server'

// Client-money server actions. Every rule lives in lib/ops/money; a money
// guard refusal comes back as "Refused and recorded: <reason> (refusal #N)"
// via the second-transaction refusal capture the plumbing owns.

import { act } from '@/lib/screens/action'
import { OperationRefused } from '@/lib/db'
import { executeHeldFundsPayment } from '@/lib/ops/billing'
import {
  recordMoneyReceipt,
  reverseMoneyTransaction,
  draftMoneyPayment,
  submitMoneyPayment,
  authoriseMoneyPayment,
  rejectMoneyPayment,
  cancelMoneyPayment,
  executeMoneyPayment,
  resubmitBlockedPayment,
  authoriseTransferIntent,
  ledgerTransfer,
  crossAccountTransfer,
  placeEarmark,
  releaseEarmark,
  emailReceipt,
  establishEntitlement,
  recordEntitlementNotice,
  cancelEntitlement,
  ingestBankStatementLines,
  buildReconciliation,
  createMatchGroup,
  dissolveMatchGroup,
  createReconException,
  resolveReconException,
  certifyReconciliation,
  openPeriodClose,
  certifyPeriodClose,
  bankInstrument,
  dishonourInstrument,
  cancelInstrument,
  linkReplacementInstrument,
  recordContactAttempt,
  resolveDormantCase,
  generateClientMoneyStatement,
  issueClientMoneyStatement,
  appendStatutoryRegisterEntry,
  promoteRefusalToIncident,
  rectifyIncident,
  reportIncident,
  openLedger,
  closeLedger,
  reopenLedger,
  createClientAccount,
  deactivateClientAccount,
} from '@/lib/ops/money'
import { parse } from '@/components/forms'

// ---- receipts & reversals ----------------------------------------------------

export async function emailReceiptAction(formData: FormData): Promise<void> {
  await act('/money/receipts', async (p) => {
    const r = await emailReceipt(p, {
      receipt: parse.num(formData, 'receipt'),
      recipients: parse.str(formData, 'recipients').split(/[;,]/),
      confirmed: formData.get('confirmed') === 'on',
    })
    return `Receipt queued to ${r.queued} recipient${r.queued === 1 ? '' : 's'} — it sends with the attached PDF within minutes.`
  })
}

export async function recordReceiptAction(formData: FormData): Promise<void> {
  await act('/money/receipt', async (p) => {
    const identifiers: Record<string, string> = {}
    const keys = formData.getAll('id_key').map(String)
    const values = formData.getAll('id_value').map(String)
    keys.forEach((k, i) => {
      if (k && values[i]) identifiers[k] = values[i]
    })
    const r = await recordMoneyReceipt(p, {
      matter: parse.num(formData, 'matter'),
      account: parse.num(formData, 'account'),
      amount: parse.num(formData, 'amount'),
      method: parse.str(formData, 'method'),
      receivedDate: parse.strOrNull(formData, 'received_date') ?? undefined,
      payerParty: parse.numOrNull(formData, 'payer_party') ?? undefined,
      payerDescription: parse.strOrNull(formData, 'payer_description') ?? undefined,
      identifiers: Object.keys(identifiers).length > 0 ? identifiers : undefined,
      instrumentNumber: parse.strOrNull(formData, 'instrument_number') ?? undefined,
    })
    return `Receipt ${r.receiptNumber} recorded — the printable form is stored.`
  })
}

export async function reverseTransactionAction(formData: FormData): Promise<void> {
  const ledger = parse.num(formData, 'ledger')
  await act(`/money/ledgers/${ledger}`, async (p) => {
    await reverseMoneyTransaction(p, {
      transaction: parse.num(formData, 'transaction'),
      reason: parse.str(formData, 'reason'),
      authorisation: parse.numOrNull(formData, 'authorisation') ?? undefined,
    })
    return 'Reversed — mirror lines posted; the pair stands forever.'
  })
}

// ---- the payment ceremony ------------------------------------------------------

export async function draftPaymentAction(formData: FormData): Promise<void> {
  await act('/money/payments', async (p) => {
    // payee identifier inputs are named payee_id_<key>, one per field the
    // pack declares (or the neutral pair) — collected exactly as typed
    const identifiers: Record<string, string> = {}
    for (const [k, v] of formData.entries()) {
      if (k.startsWith('payee_id_') && typeof v === 'string' && v.trim() !== '') {
        identifiers[k.slice('payee_id_'.length)] = v.trim()
      }
    }
    const r = await draftMoneyPayment(p, {
      matterLedger: parse.num(formData, 'matter_ledger'),
      amount: parse.num(formData, 'amount'),
      method: parse.str(formData, 'method'),
      reason: parse.str(formData, 'reason'),
      payeeParty: parse.numOrNull(formData, 'payee_party') ?? undefined,
      payeeDescription: parse.strOrNull(formData, 'payee_description') ?? undefined,
      payeeBankDetails: {
        accountName: parse.strOrNull(formData, 'payee_account_name') ?? undefined,
        identifiers,
      },
    })
    return `Payment drafted (#${r.id}) — submit it for authorisation when ready.`
  })
}

export async function submitPaymentAction(formData: FormData): Promise<void> {
  await act('/money/payments', async (p) => {
    const r = await submitMoneyPayment(p, { payment: parse.num(formData, 'payment') })
    return `Submitted — ${r.required} authorisation(s) required, frozen at submission.`
  })
}

export async function authorisePaymentAction(formData: FormData): Promise<void> {
  await act('/money/payments', async (p) => {
    await authoriseMoneyPayment(p, {
      payment: parse.num(formData, 'payment'),
      note: parse.strOrNull(formData, 'note') ?? undefined,
    })
    return 'Approved.'
  })
}

export async function rejectPaymentAction(formData: FormData): Promise<void> {
  await act('/money/payments', async (p) => {
    await rejectMoneyPayment(p, {
      payment: parse.num(formData, 'payment'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Rejected with the reason on record.'
  })
}

export async function cancelPaymentAction(formData: FormData): Promise<void> {
  await act('/money/payments', async (p) => {
    await cancelMoneyPayment(p, {
      payment: parse.num(formData, 'payment'),
      reason: parse.strOrNull(formData, 'reason') ?? undefined,
    })
    return 'Cancelled.'
  })
}

export async function executePaymentAction(formData: FormData): Promise<void> {
  await act('/money/payments', async (p) => {
    const ref = parse.strOrNull(formData, 'instrument_number') ?? undefined
    const payment = parse.num(formData, 'payment')
    try {
      await executeMoneyPayment(p, {
        payment,
        instrumentNumber: ref,
        externalReference: ref,
      })
    } catch (e) {
      // a transfer prepared for a specific bill executes through the
      // held-funds bridge — one act, money moved AND the bill paid
      if (e instanceof OperationRefused && e.code === 'held_funds_item') {
        const r = await executeHeldFundsPayment(p, { payment })
        return `Executed ${r.paymentNumber} and receipted ${r.receiptNumber} against the bill — the money has moved and the bill is paid.`
      }
      throw e
    }
    return 'Executed — posted under the protocol with its gapless number.'
  })
}

export async function resubmitPaymentAction(formData: FormData): Promise<void> {
  await act('/money/payments', async (p) => {
    await resubmitBlockedPayment(p, {
      payment: parse.num(formData, 'payment'),
      instrumentNumber: parse.strOrNull(formData, 'instrument_number') ?? undefined,
    })
    return 'Resubmitted for authorisation.'
  })
}

// ---- transfers, earmarks, entitlements ------------------------------------------

export async function authoriseIntentAction(formData: FormData): Promise<void> {
  await act('/money/transfer', async (p) => {
    const r = await authoriseTransferIntent(p, {
      fromLedger: parse.num(formData, 'from_ledger'),
      toLedger: parse.num(formData, 'to_ledger'),
      amount: parse.num(formData, 'amount'),
      reason: parse.str(formData, 'reason'),
    })
    return `Intent authorised (#${r.authorisation}) — a DIFFERENT person now executes the transfer quoting it.`
  })
}

export async function ledgerTransferAction(formData: FormData): Promise<void> {
  await act('/money/transfer', async (p) => {
    await ledgerTransfer(p, {
      fromLedger: parse.num(formData, 'from_ledger'),
      toLedger: parse.num(formData, 'to_ledger'),
      amount: parse.num(formData, 'amount'),
      reason: parse.str(formData, 'reason'),
      authorisation: parse.num(formData, 'authorisation'),
    })
    return 'Transferred — two-line zero-net posting recorded.'
  })
}

export async function crossAccountTransferAction(formData: FormData): Promise<void> {
  await act('/money/transfer', async (p) => {
    await crossAccountTransfer(p, {
      fromLedger: parse.num(formData, 'from_ledger'),
      toLedger: parse.num(formData, 'to_ledger'),
      amount: parse.num(formData, 'amount'),
      reason: parse.str(formData, 'reason'),
      authorisation: parse.num(formData, 'authorisation'),
    })
    return 'Transferred across accounts — payment and receipt in one act under the one intent.'
  })
}

export async function placeEarmarkAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/money`, async (p) => {
    await placeEarmark(p, {
      matterLedger: parse.num(formData, 'matter_ledger'),
      amount: parse.num(formData, 'amount'),
      purpose: parse.str(formData, 'purpose'),
    })
    return 'Set aside — payments now clear the remaining available first.'
  })
}

export async function releaseEarmarkAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/money`, async (p) => {
    const r = await releaseEarmark(p, {
      earmark: parse.num(formData, 'earmark'),
      reason: parse.str(formData, 'reason'),
      amount: parse.numOrNull(formData, 'amount') ?? undefined,
    })
    return r.remainderEarmark === null
      ? 'Released.'
      : 'Released in part — the remainder stays set aside.'
  })
}

export async function establishEntitlementAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/money`, async (p) => {
    await establishEntitlement(p, {
      matterLedger: parse.num(formData, 'matter_ledger'),
      amount: parse.num(formData, 'amount'),
      basisKind: 'rendered_bill',
      bill: parse.num(formData, 'bill'),
    })
    return 'Entitlement established on the rendered bill.'
  })
}

export async function entitlementNoticeAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/money`, async (p) => {
    await recordEntitlementNotice(p, {
      entitlement: parse.num(formData, 'entitlement'),
      noticeEventType: parse.str(formData, 'notice_event_type'),
      noticeEvent: parse.num(formData, 'notice_event'),
    })
    return 'Notice recorded — the clock runs from the evidence.'
  })
}

export async function cancelEntitlementAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/money`, async (p) => {
    await cancelEntitlement(p, {
      entitlement: parse.num(formData, 'entitlement'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Cancelled — only unconsumed entitlements can be.'
  })
}

export async function openLedgerAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/money`, async (p) => {
    const r = await openLedger(p, { matter, account: parse.num(formData, 'account') })
    return r.created ? 'Ledger opened.' : 'This matter already holds a ledger on that account.'
  })
}

// ---- reconciliation ------------------------------------------------------------

export async function ingestLinesAction(formData: FormData): Promise<void> {
  const account = parse.num(formData, 'account')
  await act(`/money/recon/${account}`, async (p) => {
    const dates = formData.getAll('line_date').map(String)
    const amounts = formData.getAll('line_amount').map(Number)
    const descs = formData.getAll('line_desc').map(String)
    const lines = dates
      .map((d, i) => ({ lineDate: d, amount: amounts[i], description: descs[i] || 'manual line' }))
      .filter((l) => l.lineDate && Number.isFinite(l.amount) && l.amount !== 0)
    const r = await ingestBankStatementLines(p, { account, source: 'manual', lines })
    return `${r.inserted.length} line(s) taken in${r.replayed > 0 ? `, ${r.replayed} replayed as no-ops` : ''}.`
  })
}

export async function buildReconAction(formData: FormData): Promise<void> {
  const account = parse.num(formData, 'account')
  await act(`/money/recon/${account}`, async (p) => {
    await buildReconciliation(p, {
      account,
      statementDate: parse.str(formData, 'statement_date'),
      statementBalance: parse.num(formData, 'statement_balance'),
    })
    return 'Workspace built — instrument exceptions generated and priors carried forward.'
  })
}

export async function matchAction(formData: FormData): Promise<void> {
  const account = parse.num(formData, 'account')
  await act(`/money/recon/${account}`, async (p) => {
    const statementLines = formData.getAll('m_line').map(Number).filter((n) => n > 0)
    const transactions = formData.getAll('m_txn').map(Number).filter((n) => n > 0)
    await createMatchGroup(p, {
      reconciliation: parse.num(formData, 'reconciliation'),
      statementLines,
      transactions,
    })
    return 'Matched — the group must sum to zero difference and it did.'
  })
}

export async function dissolveMatchAction(formData: FormData): Promise<void> {
  const account = parse.num(formData, 'account')
  await act(`/money/recon/${account}`, async (p) => {
    await dissolveMatchGroup(p, {
      reconciliation: parse.num(formData, 'reconciliation'),
      matchGroup: parse.num(formData, 'match_group'),
    })
    return 'Match dissolved.'
  })
}

export async function exceptionAction(formData: FormData): Promise<void> {
  const account = parse.num(formData, 'account')
  await act(`/money/recon/${account}`, async (p) => {
    await createReconException(p, {
      reconciliation: parse.num(formData, 'reconciliation'),
      exceptionType: parse.str(formData, 'exception_type') as
        | 'unpresented_payment'
        | 'unbanked_receipt'
        | 'bank_error',
      linkedType: parse.str(formData, 'linked_type') as 'transaction' | 'statement_line' | 'instrument',
      linked: parse.num(formData, 'linked'),
      amount: parse.num(formData, 'amount'),
      arisingDate: parse.str(formData, 'arising_date'),
    })
    return 'Exception recorded with its arising date.'
  })
}

export async function resolveExceptionAction(formData: FormData): Promise<void> {
  const account = parse.num(formData, 'account')
  await act(`/money/recon/${account}`, async (p) => {
    await resolveReconException(p, {
      reconciliation: parse.num(formData, 'reconciliation'),
      exception: parse.num(formData, 'exception'),
      resolutionNote: parse.str(formData, 'resolution_note'),
    })
    return 'Resolved with lineage kept.'
  })
}

export async function certifyReconAction(formData: FormData): Promise<void> {
  const account = parse.num(formData, 'account')
  await act(`/money/recon/${account}`, async (p) => {
    await certifyReconciliation(p, { reconciliation: parse.num(formData, 'reconciliation') })
    return 'Certified — the schema proved the equation to the cent and locked the matches forever.'
  })
}

// ---- closes ---------------------------------------------------------------------

export async function openCloseAction(formData: FormData): Promise<void> {
  await act('/money/close', async (p) => {
    const obligation = parse.numOrNull(formData, 'obligation')
    const r = await openPeriodClose(
      p,
      obligation
        ? { obligation }
        : {
            periodStart: parse.str(formData, 'period_start'),
            periodEnd: parse.str(formData, 'period_end'),
            account: parse.numOrNull(formData, 'account') ?? undefined,
          },
    )
    return `goto:/money/close/${r.id}?done=${encodeURIComponent('Close opened — review the listing, then certify.')}`
  })
}

export async function certifyCloseAction(formData: FormData): Promise<void> {
  const close = parse.num(formData, 'close')
  await act(`/money/close/${close}`, async (p) => {
    await certifyPeriodClose(p, { close })
    return 'Certified — the schema wrote the every-ledger listing, proved it totals the bank position, and locked the period on the posting path.'
  })
}

// ---- instruments ------------------------------------------------------------------

export async function bankInstrumentAction(formData: FormData): Promise<void> {
  await act('/money/instruments', async (p) => {
    await bankInstrument(p, {
      instrument: parse.num(formData, 'instrument'),
      depositEvidence: parse.strOrNull(formData, 'evidence') ?? undefined,
    })
    return 'Banked.'
  })
}

export async function dishonourAction(formData: FormData): Promise<void> {
  await act('/money/instruments', async (p) => {
    await dishonourInstrument(p, {
      instrument: parse.num(formData, 'instrument'),
      bankEvidence: parse.str(formData, 'evidence'),
      honouredAmount: parse.numOrNull(formData, 'honoured_amount') ?? undefined,
    })
    return 'Dishonour recorded on the bank’s authority — the reversal posted itself.'
  })
}

export async function cancelInstrumentAction(formData: FormData): Promise<void> {
  await act('/money/instruments', async (p) => {
    await cancelInstrument(p, {
      instrument: parse.num(formData, 'instrument'),
      reason: parse.str(formData, 'reason'),
      authorisation: parse.num(formData, 'authorisation'),
    })
    return 'Cancelled with its reversal and authorisation.'
  })
}

export async function linkReplacementAction(formData: FormData): Promise<void> {
  await act('/money/instruments', async (p) => {
    await linkReplacementInstrument(p, {
      cancelled: parse.num(formData, 'cancelled'),
      replacement: parse.num(formData, 'replacement'),
    })
    return 'Replacement linked both ways.'
  })
}

// ---- dormancy · incidents · refusals ----------------------------------------------

export async function contactAttemptAction(formData: FormData): Promise<void> {
  await act('/money/dormant', async (p) => {
    await recordContactAttempt(p, {
      case: parse.num(formData, 'case'),
      channel: parse.str(formData, 'channel'),
      evidence: parse.str(formData, 'evidence'),
    })
    return 'Attempt recorded with evidence.'
  })
}

export async function resolveDormantAction(formData: FormData): Promise<void> {
  await act('/money/dormant', async (p) => {
    await resolveDormantCase(p, {
      case: parse.num(formData, 'case'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Case resolved.'
  })
}

export async function promoteRefusalAction(formData: FormData): Promise<void> {
  await act('/money/refusals', async (p) => {
    await promoteRefusalToIncident(p, {
      refusal: parse.num(formData, 'refusal'),
      narrative: parse.str(formData, 'narrative'),
    })
    return 'Promoted to a deficiency incident — exactly once.'
  })
}

export async function rectifyIncidentAction(formData: FormData): Promise<void> {
  await act('/money/incidents', async (p) => {
    const txns = parse
      .str(formData, 'transactions')
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => n > 0)
    await rectifyIncident(p, {
      incident: parse.num(formData, 'incident'),
      correctingTransactions: txns,
      note: parse.str(formData, 'note'),
    })
    return 'Rectified, naming the correcting transactions.'
  })
}

export async function reportIncidentAction(formData: FormData): Promise<void> {
  await act('/money/incidents', async (p) => {
    await reportIncident(p, { incident: parse.num(formData, 'incident') })
    return 'Reported — the notification artefact is stored.'
  })
}

// ---- statements · registers · accounts ---------------------------------------------

export async function generateMoneyStatementAction(formData: FormData): Promise<void> {
  await act('/money/statements', async (p) => {
    const r = await generateClientMoneyStatement(p, {
      matterLedger: parse.num(formData, 'matter_ledger'),
      periodStart: parse.str(formData, 'period_start'),
      periodEnd: parse.str(formData, 'period_end'),
      triggerKind: 'on_request',
    })
    return `Statement ${r.statementNumber} generated.`
  })
}

export async function issueMoneyStatementAction(formData: FormData): Promise<void> {
  await act('/money/statements', async (p) => {
    await issueClientMoneyStatement(p, {
      statement: parse.num(formData, 'statement'),
      channel: parse.str(formData, 'channel') as 'email' | 'print' | 'portal',
      recipient: parse.strOrNull(formData, 'recipient') ?? undefined,
    })
    return 'Issued — exactly once per statement.'
  })
}

export async function appendRegisterEntryAction(formData: FormData): Promise<void> {
  await act('/money/registers', async (p) => {
    const values: Record<string, unknown> = {}
    const keys = formData.getAll('v_key').map(String)
    const vals = formData.getAll('v_value').map(String)
    keys.forEach((k, i) => {
      if (k && vals[i] !== '') values[k] = vals[i]
    })
    await appendStatutoryRegisterEntry(p, {
      registerKey: parse.str(formData, 'register_key'),
      values,
    })
    return 'Entry appended under the per-register lock, densely numbered.'
  })
}

export async function createAccountAction(formData: FormData): Promise<void> {
  await act('/money', async (p) => {
    await createClientAccount(p, {
      name: parse.str(formData, 'name'),
      accountKind: parse.str(formData, 'account_kind') as
        | 'pooled'
        | 'separate_per_matter'
        | 'statutory_set_aside',
      linkedMatter: parse.numOrNull(formData, 'linked_matter') ?? undefined,
    })
    return 'Account created.'
  })
}

export async function deactivateAccountAction(formData: FormData): Promise<void> {
  await act('/money', async (p) => {
    await deactivateClientAccount(p, {
      account: parse.num(formData, 'account'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Deactivated — the schema demanded a zero book, closed ledgers and a certified final reconciliation first.'
  })
}

export async function closeLedgerAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/money`, async (p) => {
    await closeLedger(p, { ledger: parse.num(formData, 'ledger') })
    return 'Ledger closed at exactly zero, with the closing copy stored first.'
  })
}

export async function reopenLedgerAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/money`, async (p) => {
    await reopenLedger(p, { ledger: parse.num(formData, 'ledger'), reason: parse.str(formData, 'reason') })
    return 'Reopened (privileged, with the reason on the register).'
  })
}
