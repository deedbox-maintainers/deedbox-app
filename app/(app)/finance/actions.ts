'use server'

// Firm-accounts server actions: parse → named GL operation →
// notice. The verbs land back on the workbench; setup lands on settings.

import { act } from '@/lib/screens/action'
import {
  enableGl,
  lockGlMonth,
  createGlAccount,
  updateGlAccount,
  createGlTaxCode,
  createGlContact,
  createManualJournal,
  reverseGlJournal,
  postOpeningBalances,
  createGlBill,
  approveGlBill,
  voidGlBill,
  createGlBankAccount,
  importStatementRows,
  parseStatementCsv,
  createGlBankRule,
  reconcileReceive,
  reconcileSpend,
  reconcileMatchBill,
  reconcileTransfer,
  reconcileIgnore,
  autoReconcile,
  runGlSync,
  toCents,
} from '@/lib/ops/gl'

const num = (v: FormDataEntryValue | null) => Number(v ?? 0)
const str = (v: FormDataEntryValue | null) => String(v ?? '').trim()
const opt = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim()
  return s ? s : null
}
const optNum = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim()
  return s ? Number(s) : null
}

export async function enableGlAction(formData: FormData): Promise<void> {
  await act('/finance/settings', async (p) => {
    const r = await enableGl(p, { conversionDate: str(formData.get('conversion_date')) })
    return r.seededAccounts > 0
      ? `Module switched on — ${r.seededAccounts} starter accounts created.`
      : 'Module configuration updated.'
  })
}

export async function lockMonthAction(formData: FormData): Promise<void> {
  await act('/finance/settings', async (p) => {
    await lockGlMonth(p, { monthStart: str(formData.get('month')) + '-01' })
    return 'Month locked. Nothing can post into it again.'
  })
}

export async function createAccountAction(formData: FormData): Promise<void> {
  await act('/finance/accounts', async (p) => {
    await createGlAccount(p, {
      code: str(formData.get('code')),
      name: str(formData.get('name')),
      accountType: str(formData.get('account_type')),
    })
    return 'Account added.'
  })
}

export async function updateAccountAction(formData: FormData): Promise<void> {
  await act('/finance/accounts', async (p) => {
    await updateGlAccount(p, {
      id: num(formData.get('id')),
      code: str(formData.get('code')),
      name: str(formData.get('name')),
      active: formData.get('active') === 'on',
    })
    return 'Account saved.'
  })
}

export async function createTaxCodeAction(formData: FormData): Promise<void> {
  await act('/finance/accounts', async (p) => {
    await createGlTaxCode(p, {
      code: str(formData.get('code')),
      name: str(formData.get('name')),
      ratePercent: num(formData.get('rate_percent')),
    })
    return 'Tax code added.'
  })
}

export async function createContactAction(formData: FormData): Promise<void> {
  await act('/finance/contacts', async (p) => {
    await createGlContact(p, {
      name: str(formData.get('name')),
      email: opt(formData.get('email')),
      phone: opt(formData.get('phone')),
      taxIdentifier: opt(formData.get('tax_identifier')),
    })
    return 'Contact added.'
  })
}

export async function manualJournalAction(formData: FormData): Promise<void> {
  await act('/finance/journals/new', async (p) => {
    const lines: { account: number; debitCents: number; creditCents: number; description: string | null }[] = []
    for (let i = 0; i < 8; i++) {
      const account = optNum(formData.get(`line_${i}_account`))
      if (!account) continue
      lines.push({
        account,
        debitCents: toCents(formData.get(`line_${i}_debit`) || 0),
        creditCents: toCents(formData.get(`line_${i}_credit`) || 0),
        description: opt(formData.get(`line_${i}_description`)),
      })
    }
    const r = await createManualJournal(p, {
      journalDate: str(formData.get('journal_date')),
      description: str(formData.get('description')),
      lines,
    })
    return `goto:/finance/journals/${r.id}?done=${encodeURIComponent(`Posted as ${r.journalNo}.`)}`
  })
}

export async function reverseJournalAction(formData: FormData): Promise<void> {
  const id = num(formData.get('id'))
  await act(`/finance/journals/${id}`, async (p) => {
    const r = await reverseGlJournal(p, { id })
    return `Reversed by ${r.reversalNo}.`
  })
}

export async function openingBalancesAction(formData: FormData): Promise<void> {
  await act('/finance/settings', async (p) => {
    const lines: { account: number; debitCents: number; creditCents: number }[] = []
    for (let i = 0; i < 12; i++) {
      const account = optNum(formData.get(`ob_${i}_account`))
      if (!account) continue
      lines.push({
        account,
        debitCents: toCents(formData.get(`ob_${i}_debit`) || 0),
        creditCents: toCents(formData.get(`ob_${i}_credit`) || 0),
      })
    }
    const r = await postOpeningBalances(p, { asOf: str(formData.get('as_of')), lines })
    return `Opening balances posted as ${r.journalNo}.`
  })
}

export async function createBillAction(formData: FormData): Promise<void> {
  await act('/finance/bills', async (p) => {
    const lines: { account: number; taxCode: number | null; description: string | null; netCents: number; taxCents: number }[] = []
    for (let i = 0; i < 6; i++) {
      const account = optNum(formData.get(`line_${i}_account`))
      if (!account) continue
      lines.push({
        account,
        taxCode: optNum(formData.get(`line_${i}_tax_code`)),
        description: opt(formData.get(`line_${i}_description`)),
        netCents: toCents(formData.get(`line_${i}_net`) || 0),
        taxCents: toCents(formData.get(`line_${i}_tax`) || 0),
      })
    }
    await createGlBill(p, {
      contact: num(formData.get('contact')),
      billNumber: opt(formData.get('bill_number')),
      billDate: str(formData.get('bill_date')),
      dueDate: opt(formData.get('due_date')),
      description: opt(formData.get('description')),
      lines,
    })
    return 'Bill saved as a draft.'
  })
}

export async function approveBillAction(formData: FormData): Promise<void> {
  await act('/finance/bills', async (p) => {
    await approveGlBill(p, { id: num(formData.get('id')) })
    return 'Bill approved — the payable is on the books.'
  })
}

export async function voidBillAction(formData: FormData): Promise<void> {
  await act('/finance/bills', async (p) => {
    await voidGlBill(p, { id: num(formData.get('id')) })
    return 'Draft voided.'
  })
}

export async function createBankAccountAction(formData: FormData): Promise<void> {
  await act('/finance/reconcile', async (p) => {
    await createGlBankAccount(p, {
      name: str(formData.get('name')),
      code: str(formData.get('code')),
      kind: (opt(formData.get('kind')) as 'bank' | 'credit_card' | null) ?? 'bank',
      bankIdentifier: opt(formData.get('bank_identifier')),
      accountNumber: opt(formData.get('account_number')),
    })
    return 'Bank account added.'
  })
}

export async function importCsvAction(formData: FormData): Promise<void> {
  const bankAccount = num(formData.get('bank_account'))
  await act(`/finance/reconcile?account=${bankAccount}`, async (p) => {
    const file = formData.get('file')
    if (!(file instanceof File) || file.size === 0) {
      return 'Choose a CSV file first.'
    }
    const text = await file.text()
    const rows = parseStatementCsv(text, {
      date: optNum(formData.get('col_date')) ?? 0,
      amount: optNum(formData.get('col_amount')) ?? 1,
      description: optNum(formData.get('col_description')) ?? 2,
      reference: formData.get('col_reference') ? optNum(formData.get('col_reference')) : undefined,
    } as Record<string, unknown>)
    const r = await importStatementRows(p, { bankAccount, filename: file.name, rows })
    return `Imported ${r.inserted} lines (${r.duplicates} already known).`
  })
}

export async function createRuleAction(formData: FormData): Promise<void> {
  await act('/finance/settings', async (p) => {
    await createGlBankRule(p, {
      name: str(formData.get('name')),
      matchDescOp: (opt(formData.get('match_desc_op')) as 'contains' | 'equals' | null) ?? null,
      matchDesc: opt(formData.get('match_desc')),
      matchRef: opt(formData.get('match_ref')),
      direction: (str(formData.get('direction')) as 'in' | 'out' | 'any') || 'any',
      action: (str(formData.get('action')) as 'receive_money' | 'spend_money' | 'suggest_only') || 'suggest_only',
      account: optNum(formData.get('account')),
      taxCode: optNum(formData.get('tax_code')),
      autoPost: formData.get('auto_post') === 'on',
    })
    return 'Rule added.'
  })
}

function verbBack(formData: FormData): string {
  return `/finance/reconcile?account=${num(formData.get('bank_account'))}`
}

export async function receiveAction(formData: FormData): Promise<void> {
  await act(verbBack(formData), async (p) => {
    const r = await reconcileReceive(p, {
      lineId: num(formData.get('line')),
      account: num(formData.get('account')),
      taxCode: optNum(formData.get('tax_code')),
      description: opt(formData.get('description')),
    })
    return `Received — posted as ${r.journalNo}.`
  })
}

export async function spendAction(formData: FormData): Promise<void> {
  await act(verbBack(formData), async (p) => {
    const r = await reconcileSpend(p, {
      lineId: num(formData.get('line')),
      account: num(formData.get('account')),
      taxCode: optNum(formData.get('tax_code')),
      description: opt(formData.get('description')),
    })
    return `Spent — posted as ${r.journalNo}.`
  })
}

export async function matchBillAction(formData: FormData): Promise<void> {
  await act(verbBack(formData), async (p) => {
    const r = await reconcileMatchBill(p, {
      lineId: num(formData.get('line')),
      billId: num(formData.get('bill')),
    })
    return `Bill paid — posted as ${r.journalNo}.`
  })
}

export async function transferAction(formData: FormData): Promise<void> {
  await act(verbBack(formData), async (p) => {
    const r = await reconcileTransfer(p, {
      lineId: num(formData.get('line')),
      otherBankAccount: num(formData.get('other_bank_account')),
    })
    return `Transfer recorded as ${r.journalNo}.`
  })
}

export async function ignoreAction(formData: FormData): Promise<void> {
  await act(verbBack(formData), async (p) => {
    await reconcileIgnore(p, { lineId: num(formData.get('line')) })
    return 'Line set aside.'
  })
}

export async function autoReconcileAction(formData: FormData): Promise<void> {
  await act(verbBack(formData), async (p) => {
    const r = await autoReconcile(p, { bankAccount: num(formData.get('bank_account')) })
    return `Rules posted ${r.posted}; ${r.leftForReview} left for review.`
  })
}

export async function syncNowAction(): Promise<void> {
  await act('/finance', async (p) => {
    const r = await runGlSync(p)
    return r.configured
      ? `Practice bridge: ${r.posted} posted, ${r.skipped} waiting.`
      : 'The module is not configured yet.'
  })
}
