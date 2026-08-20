// Client-facing outbound presentation: the pure presenters turn
// frozen data renderings into finished messages (a client never receives a
// raw data document); the bill document renders from the DESPATCH rendering
// alone (identity enriched at queue time, so preview = delivery,
// byte-for-byte) and is NEVER sent without its PDF; the transport carries
// subject/text/attachments to the mail API.
//
// Cross-suite contract: flips NO settings; queues one outbound row via the
// real send ceremony but never runs the GLOBAL dispatcher (the queue is a
// shared-scratch global — transport behaviour is proven by direct calls).
// Fixture tag 'pre' (first-three unique).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { presenterFor, billDocumentHtml, requisitionDocumentHtml, ledgerDocumentHtml } from '@/lib/ops/outbound'
import { emailTransport, type HttpPost } from '@/lib/bindings'
import {
  addStaffRate,
  createTimeEntry,
  createDraftBillGroup,
  issueBillGroup,
  previewBillSend,
  sendBill,
} from '@/lib/ops/billing'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal

const fakePdf = async (html: string) => Buffer.from(`%PDF-FAKE\n${html.length}`)

function recordingPost(): { post: HttpPost; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = []
  return {
    post: async (url, _headers, body) => {
      calls.push({ url, body })
      return { status: 200, text: 'ok' }
    },
    calls,
  }
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'pre')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('outbound presentation', () => {
  it('reminder and instalment renderings unwrap into finished text messages', async () => {
    const reminder = await presenterFor('bill_reminder')!(
      { document: 'reminder_message', channel: 'email', subject: 'Your bill B-000123', body: 'A friendly nudge.' },
      {},
    )
    expect(reminder).toEqual({ subject: 'Your bill B-000123', text: 'A friendly nudge.' })

    const noSubject = await presenterFor('bill_reminder')!(
      { document: 'reminder_message', channel: 'email', subject: null, body: 'Nudge.' },
      {},
    )
    expect(noSubject.subject).toBe('Payment reminder')

    const instalment = await presenterFor('instalment_notice')!(
      { document: 'instalment_notice', body: 'An instalment of 100.00 falls due on 2026-09-01.' },
      {},
    )
    expect(instalment.subject).toBe('Instalment due')
    expect(instalment.text).toContain('falls due on 2026-09-01')
  })

  it('a scheduled report becomes a CSV attachment, quoting handled', async () => {
    const presented = await presenterFor('scheduled_report')!(
      {
        format: 'csv',
        title: 'Key activity',
        rows: [
          { matter: 12, note: 'plain' },
          { matter: 13, note: 'has, comma and "quotes"' },
        ],
      },
      {},
    )
    expect(presented.subject).toBe('Key activity')
    expect(presented.attachments).toHaveLength(1)
    const csv = Buffer.from(presented.attachments![0].contentBase64, 'base64').toString('utf8')
    expect(csv.split('\n')[0]).toBe('matter,note')
    expect(csv).toContain('"has, comma and ""quotes"""')
    expect(presented.attachments![0].filename).toBe('Key activity.csv')
  })

  it('the bill document renders from the frozen rendering alone and refuses to travel without its PDF', async () => {
    const rendering = {
      document: 'bill',
      bill_number: 'B-000042',
      matter_number: 'PRE-0001',
      client_name: 'Pre Client',
      firm_name: 'Presentation Test Firm',
      issue_date: '2026-08-15',
      terms_days: '14',
      total: 440,
      lines: [{ kind: 'time', description: 'Advice re the deed', amount: 400, tax_amount: 40 }],
      interest_statement: { annual_rate_pct: 6.35 },
      payment_details: {
        account_holder_name: 'Presentation Test Firm Pty Ltd',
        bank_name: 'Test Bank',
        identifier_values: { bsb: '000-000', account_number: '12345678' },
        reference: 'matter_reference',
      },
    }
    const html = billDocumentHtml(rendering)
    expect(html).toContain('B-000042')
    expect(html).toContain('PRE-0001')
    expect(html).toContain('Pre Client')
    expect(html).toContain('Advice re the deed')
    expect(html).toContain('$440.00')
    expect(html).toContain('000-000')
    expect(html).toContain('6.35')

    await expect(presenterFor('bill_despatch')!(rendering, {})).rejects.toThrow(
      /converter_not_configured/,
    )

    const presented = await presenterFor('bill_despatch')!(rendering, { htmlToPdf: fakePdf })
    expect(presented.subject).toBe('Invoice B-000042 — PRE-0001')
    expect(presented.attachments).toHaveLength(1)
    expect(presented.attachments![0].filename).toBe('Invoice B-000042.pdf')
    expect(
      Buffer.from(presented.attachments![0].contentBase64, 'base64').toString('utf8').startsWith('%PDF-FAKE'),
    ).toBe(true)
  })

  it("the document's name, currency and firm identity ride the rendering — pack and firm data, never engine words", async () => {
    const rendering = {
      document: 'bill',
      bill_number: 'B-000045',
      matter_number: 'PRE-0003',
      client_name: 'Pre Client',
      firm_name: 'Presentation Test Firm',
      total: 440,
      lines: [{ kind: 'time', description: 'Advice', amount: 400, tax_amount: 40 }],
      payment_details: null,
      document_title: 'Fee Note',
      regional: { currency: 'GBP', locale: 'en-GB' },
      firm_identity: {
        legal_name: 'Presentation Test Firm Pty Ltd',
        address: '1 Example Street, Exampleton',
        registration_label: 'Reg. no.',
        registration_number: '12 345 678 901',
      },
    }
    const html = billDocumentHtml(rendering)
    expect(html).toContain('Fee Note')
    expect(html).not.toContain('Invoice</div>') // the enriched title replaces the neutral one
    expect(html).toContain('£440.00')
    expect(html).toContain('Presentation Test Firm Pty Ltd')
    expect(html).toContain('Reg. no. 12 345 678 901')
    expect(html).toContain('1 Example Street, Exampleton')

    const presented = await presenterFor('bill_despatch')!(rendering, { htmlToPdf: fakePdf })
    expect(presented.subject).toBe('Fee Note B-000045 — PRE-0003')
    expect(presented.attachments![0].filename).toBe('Fee Note B-000045.pdf')
    expect(presented.text).toContain('fee note B-000045')

    // an old rendering (queued before enrichment existed) keeps its shape:
    // neutral title, compatibility currency
    const old = billDocumentHtml({ document: 'bill', bill_number: 'B-1', total: 110, lines: [{ description: 'x', amount: 100, tax_amount: 10 }] })
    expect(old).toContain('Invoice')
    expect(old).toContain('$110.00')
  })

  it('the transport carries a presented message whole — subject, body, attachment', async () => {
    const { post, calls } = recordingPost()
    await emailTransport({ apiKey: 'k', from: 'Firm <no-reply@firm.test>', endpoint: 'https://mail.test/send', post, htmlToPdf: fakePdf })({
      id: 90,
      channel: 'email',
      recipient: 'client@example.test',
      content: JSON.stringify({
        document: 'bill',
        bill_number: 'B-000043',
        matter_number: 'PRE-0002',
        firm_name: 'Presentation Test Firm',
        total: 110,
        lines: [{ description: 'Fixed fee', amount: 100, tax_amount: 10 }],
        payment_details: null,
      }),
      purpose: 'bill_despatch',
      contentType: 'application/json',
    })
    expect(calls).toHaveLength(1)
    const sent = JSON.parse(calls[0].body)
    expect(sent.subject).toBe('Invoice B-000043 — PRE-0002')
    expect(sent.attachments).toHaveLength(1)
    expect(sent.attachments[0].filename).toBe('Invoice B-000043.pdf')

    // converter missing = the row fails typed; nothing reaches the mail API
    const bare = recordingPost()
    await expect(
      emailTransport({ apiKey: 'k', from: 'F <n@f.test>', endpoint: 'https://mail.test/send', post: bare.post })({
        id: 91,
        channel: 'email',
        recipient: 'client@example.test',
        content: JSON.stringify({ document: 'bill', bill_number: 'B-000044' }),
        purpose: 'bill_despatch',
        contentType: 'application/json',
      }),
    ).rejects.toThrow(/converter_not_configured/)
    expect(bare.calls).toHaveLength(0)

    // a finished reminder rides through as plain text
    const rem = recordingPost()
    await emailTransport({ apiKey: 'k', from: 'F <n@f.test>', endpoint: 'https://mail.test/send', post: rem.post })({
      id: 92,
      channel: 'email',
      recipient: 'client@example.test',
      content: JSON.stringify({ document: 'reminder_message', subject: 'Bill B-9', body: 'Nudge.' }),
      purpose: 'bill_reminder',
      contentType: 'application/json',
    })
    expect(JSON.parse(rem.calls[0].body)).toMatchObject({ subject: 'Bill B-9', text: 'Nudge.' })
  })

  it('the send ceremony freezes identity into the despatch rendering — preview equals delivery', async () => {
    const te = await createTimeEntry(P, {
      matter: fx.matter,
      workDate: '2026-08-15',
      units: 10, // 400.00 at the fixture rate
      narrative: 'Advice re the presentation deed',
    })
    const g = await createDraftBillGroup(P, { matter: fx.matter, timeEntries: [te.id] })
    await issueBillGroup(P, { group: g.group })
    const bill = (
      await admin.query(`select id, bill_number, matter from deedbox.bill where bill_group = $1`, [g.group])
    ).rows[0] as { id: number; bill_number: string; matter: number }

    const preview = await previewBillSend(P, { bill: bill.id })
    const rendering = preview.rendering as Record<string, unknown>
    expect(rendering.bill_number).toBe(bill.bill_number)
    expect(typeof rendering.matter_number).toBe('string')
    expect(rendering.firm_name).toBeTruthy()

    const sent = await sendBill(P, { bill: bill.id, recipients: ['payer@example.test'], confirmed: true })
    expect(sent.queued).toBe(1)
    const queued = await admin.query(
      `select om.state, sa.content_ref
         from deedbox.outbound_message om
         join deedbox.stored_artefact sa on sa.id = om.rendered_artefact::bigint
        where om.purpose = 'bill_despatch' and om.related = $1`,
      [bill.id],
    )
    expect(queued.rowCount).toBe(1)
    expect(queued.rows[0].state).toBe('queued')
    const stored = JSON.parse(queued.rows[0].content_ref as string) as Record<string, unknown>
    expect(stored.bill_number).toBe(bill.bill_number)
    expect(stored.matter_number).toBe(rendering.matter_number)
    expect(stored.firm_name).toBe(rendering.firm_name)

    // the frozen despatch rendering presents without touching the database
    const presented = await presenterFor('bill_despatch')!(stored, { htmlToPdf: fakePdf })
    expect(presented.subject).toContain(bill.bill_number)
    expect(presented.attachments).toHaveLength(1)
  })
})

describe('the receipt email presenter (0055 batch)', () => {
  const rendering = {
    document: 'money_receipt_email',
    firm_name: 'Test Firm',
    receipt_number: 'R-000123',
    received_date: '2026-08-10',
    amount: 350,
    method: 'electronic_transfer',
    matter_number: 'M-2026-00001',
    matter_title: 'Receipt host',
    client_name: 'Casey Client',
    payer_description: 'trust deposit',
  }

  it('never sends without the document', async () => {
    await expect(presenterFor('money_receipt')!(rendering, {})).rejects.toThrow(
      /converter_not_configured/,
    )
  })

  it('renders the receipt PDF attachment with an honest subject', async () => {
    const presented = await presenterFor('money_receipt')!(rendering, { htmlToPdf: fakePdf })
    expect(presented.subject).toContain('R-000123')
    expect(presented.subject).toContain('M-2026-00001')
    expect(presented.attachments).toHaveLength(1)
    expect(presented.attachments![0].filename).toContain('R-000123')
    expect(presented.attachments![0].contentType).toBe('application/pdf')
    expect(presented.text).toContain('receipt')
  })
})

describe('the payment requisition document', () => {
  it('renders the payment, payer account, payee bank details and authorisation trail', () => {
    const html = requisitionDocumentHtml({
      payment: {
        id: 41,
        firm_name: 'Northgate Law',
        payment_number: 'P-000123',
        state: 'executed',
        matter_number: 'M-2026-00001',
        matter_title: 'Sale of 1 Example Street',
        client_name: 'Ada Example',
        ledger_number: 'L1-000001',
        account_name: 'Client Account',
        account_bank_identifiers: { bank: 'Example Bank', bsb: '013-999', account_number: '111222333' },
        payee_name: 'Example Conveyancing Trust',
        payee_bank_details: { account_name: 'Example Conveyancing Trust', bsb: '014-111', account_number: '444555666' },
        amount: 12345.67,
        method: 'eft',
        purpose: 'general',
        reason: 'settlement funds',
        requester_name: { given: 'Pat', family: 'Chen' },
        created_at: '2026-08-15T01:00:00Z',
        submitted_at: '2026-08-15T01:05:00Z',
        executed_at: '2026-08-15T02:00:00Z',
        external_reference: 'BANKREF-778899',
      },
      authorisations: [
        { decision: 'approved', person_name: { given: 'Sam', family: 'Ruiz' }, decided_at: '2026-08-15T01:10:00Z' },
      ],
    })
    expect(html).toContain('EFT Requisition')
    expect(html).toContain('P-000123')
    expect(html).toContain('BSB 014-111')
    expect(html).toContain('12,345.67')
    expect(html).toContain('Approved by Sam Ruiz')
    expect(html).toContain('BANKREF-778899')
    expect(html).toContain('Example Bank')
  })
})

describe('the trust-to-office requisition payee', () => {
  it("prints the firm's own bank details when the payee has none recorded", () => {
    const html = requisitionDocumentHtml({
      payment: {
        id: 9,
        firm_name: 'Northgate Law',
        payment_number: 'P-000009',
        state: 'executed',
        matter_number: 'M-2026-00002',
        matter_title: 'Example matter',
        client_name: 'Ada Example',
        ledger_number: 'L1-000002',
        account_name: 'Client Account',
        account_bank_identifiers: { bank: 'Example Bank', bsb: '013-999', account_number: '111222333' },
        payee_description: 'the firm — costs transfer',
        amount: 100,
        method: 'eft',
        purpose: 'firm_transfer',
        reason: 'transfer of billed costs',
        requester_name: { given: 'Pat', family: 'Chen' },
        created_at: '2026-08-15T01:00:00Z',
        firm_payee_details: {
          'account holder': 'Northgate Law Pty Ltd',
          bank: 'Example Bank',
          bsb: '013-222',
          account_number: '999888777',
        },
      },
      authorisations: [],
    })
    expect(html).toContain('the firm — costs transfer')
    expect(html).toContain('Northgate Law Pty Ltd')
    expect(html).toContain('BSB 013-222')
    expect(html).toContain('account number 999888777')
    expect(html).not.toContain('not recorded')
  })
})

describe('the ledger document', () => {
  it('renders the header, every line in entry order, and the closing balance', () => {
    const html = ledgerDocumentHtml({
      ledger: {
        id: 7,
        firm_name: 'Northgate Law',
        ledger_number: 'L1-000007',
        status: 'open',
        ledger_kind: 'matter',
        matter: 12,
        matter_number: 'M-2026-00012',
        title: 'Estate of Example',
        client_name: 'Ada Example',
        account_name: 'Client Account',
        bank_identifiers: { bank: 'Example Bank', bsb: '013-999', account_number: '111222333' },
        balance: 350.45,
      },
      lines: [
        { entry_no: 1, signed_amount: 500, running_balance: 500, txn_kind: 'receipt', effective_date: '2026-08-01', reason: 'on account' },
        { entry_no: 2, signed_amount: -149.55, running_balance: 350.45, txn_kind: 'payment', effective_date: '2026-08-10', reason: 'filing fee' },
      ],
    })
    expect(html).toContain('Client Money Ledger')
    expect(html).toContain('L1-000007')
    expect(html).toContain('Ada Example')
    expect(html).toContain('$500.00')
    expect(html).toContain('-$149.55')
    expect(html).toContain('$350.45')
    expect(html.indexOf('on account')).toBeLessThan(html.indexOf('filing fee'))
  })
})

describe('the standing bill notice (0056)', () => {
  it('renders when embedded and stays silent when absent', () => {
    const base = { document: 'bill', bill_number: 'B-1', total: 110, lines: [] }
    const withNotice = billDocumentHtml({
      ...base,
      notice: { heading: 'Example Funding Co (for Family Law & Estate Law Matters)', text: 'Our firm is accredited with Example Funding Co.' },
    })
    expect(withNotice).toContain('Example Funding Co (for Family Law')
    expect(withNotice).toContain('accredited with Example Funding Co')
    const without = billDocumentHtml(base)
    expect(without).not.toContain('Example Funding Co')
  })
})
