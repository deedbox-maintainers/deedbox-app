// Client-facing outbound presentation: the pure step that turns
// a stored DATA rendering (application/json — frozen at queue time, the
// evidence) into a FINISHED message a client may receive. Presenters are
// pure functions of the stored content alone — everything a message needs
// (identity, names, numbers) is enriched into the rendering when it is
// QUEUED, so the send-ceremony preview and the delivered message can never
// diverge. A JSON purpose with no presenter here keeps the transport's
// typed 'presentation_pending' refusal: a client never receives a raw data
// document.

export interface PresentedAttachment {
  filename: string
  contentType: string
  /** base64 — the shape the mail API carries. */
  contentBase64: string
}

export interface PresentedMessage {
  subject: string
  text?: string
  html?: string
  attachments?: PresentedAttachment[]
}

/** The HTML→PDF converter seam (bound at boot; injectable for tests). */
export type HtmlToPdf = (html: string) => Promise<Buffer>

export interface PresentContext {
  /** Absent = no converter on this installation; presenters that promise a
   *  PDF must throw typed rather than send without it. */
  htmlToPdf?: HtmlToPdf
}

import {
  formatMoney,
  regionalFrom,
  DISPLAY_LOCALE,
  DOCUMENT_PAGE_SIZE,
  type Regional,
} from '@/lib/format'

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

// Money renders in the firm's own currency: the regional block is enriched
// into each rendering at queue time; a rendering without one (queued before
// enrichment existed) falls back to the compatibility defaults and appears
// exactly as it always did.
const money = (n: unknown, r?: Regional | null): string => formatMoney(n, r)

/** The firm's trading identity, enriched at queue time; every field optional. */
interface FirmIdentity {
  legal_name?: string | null
  address?: string | null
  registration_label?: string | null
  registration_number?: string | null
}

function firmIdentityHtml(fi?: FirmIdentity | null): string {
  if (!fi) return ''
  const lines: string[] = []
  if (fi.legal_name) lines.push(esc(fi.legal_name))
  if (fi.registration_number) {
    lines.push(`${esc(fi.registration_label ?? 'Registration no.')} ${esc(fi.registration_number)}`)
  }
  if (fi.address) lines.push(esc(fi.address))
  return lines.length > 0 ? `<div class="small">${lines.join('<br>')}</div>` : ''
}

// The generated-document page CSS.
const PAGE_CSS = `
  @page { size: ${DOCUMENT_PAGE_SIZE}; margin: 16mm; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, Arial, sans-serif; color:#0f172a; font-size:13px; }
  .wrap { max-width: 760px; margin: 0 auto; }
  .firm { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #0f172a; padding-bottom:12px; margin-bottom:18px; }
  .firm h1 { font-size:20px; margin:0; }
  .small { font-size:11px; color:#64748b; line-height:1.4; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin:22px 0 8px; }
  .doc-title { font-size:22px; font-weight:700; margin:0 0 2px; }
  .row { display:flex; justify-content:space-between; gap:24px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th,td { padding:6px 6px; text-align:left; border-bottom:1px solid #e2e8f0; vertical-align:top; }
  th { font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; color:#64748b; }
  .right { text-align:right; font-variant-numeric:tabular-nums; }
  .grand { font-weight:700; font-size:14px; border-top:2px solid #0f172a; }
  .muted { color:#64748b; }
`

// ---------------------------------------------------------------------------
// Presenters, one per queued JSON purpose.
// ---------------------------------------------------------------------------

interface ReminderRendering {
  document: string
  subject?: string | null
  body?: string
}

function presentReminder(data: ReminderRendering): PresentedMessage {
  return {
    subject: (data.subject ?? '').trim() || 'Payment reminder',
    text: data.body ?? '',
  }
}

interface InstalmentRendering {
  document: string
  body?: string
}

function presentInstalment(data: InstalmentRendering): PresentedMessage {
  return { subject: 'Instalment due', text: data.body ?? '' }
}

interface ScheduledReportRendering {
  format?: string
  title?: string
  rows?: Record<string, unknown>[]
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function presentScheduledReport(data: ScheduledReportRendering): PresentedMessage {
  const rows = Array.isArray(data.rows) ? data.rows : []
  const title = (data.title ?? 'Scheduled report').trim() || 'Scheduled report'
  const columns = rows.length > 0 ? Object.keys(rows[0]) : []
  const csv = [
    columns.map(csvCell).join(','),
    ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')),
  ].join('\n')
  const safe = title.replace(/[^\w.\-() ]+/g, '_').slice(0, 120)
  return {
    subject: title,
    text: `${title} — ${rows.length} row${rows.length === 1 ? '' : 's'}, attached as a spreadsheet file.`,
    attachments: [
      {
        filename: `${safe}.csv`,
        contentType: 'text/csv',
        contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
      },
    ],
  }
}

interface BillDespatchRendering {
  document: string
  bill_number?: string
  matter_number?: string
  client_name?: string
  firm_name?: string
  issue_date?: string
  terms_days?: string | number
  /** The firm's standing notice, embedded at issue (0056). */
  notice?: { heading?: string | null; text?: string } | null
  total?: number
  lines?: {
    kind?: string
    description?: string | null
    amount?: number | string
    tax_amount?: number | string
  }[]
  interest_statement?: { annual_rate_pct?: number } | null
  payment_details?: {
    account_holder_name?: string
    bank_name?: string
    identifier_values?: Record<string, string>
    reference?: string
  } | null
  /** The document's name — pack wording via strings.bill_title, enriched at
   *  queue time; absent (old renderings) = the engine's neutral title. */
  document_title?: string | null
  /** Enriched at queue time from the firm's own facts. */
  regional?: { currency?: string; locale?: string } | null
  firm_identity?: FirmIdentity | null
}

/** The bill document HTML — rendered from the FROZEN despatch rendering
 *  alone, never from live rows (what was issued is what is sent). */
export function billDocumentHtml(data: BillDespatchRendering): string {
  const R = regionalFrom(data.regional)
  const title = (data.document_title ?? '').trim() || 'Invoice'
  const lines = Array.isArray(data.lines) ? data.lines : []
  const lineRows = lines
    .map((l) => {
      const net = Number(l.amount ?? 0)
      const tax = Number(l.tax_amount ?? 0)
      return `<tr><td>${esc(l.description ?? l.kind ?? '')}</td><td class="right">${money(net, R)}</td><td class="right">${money(tax, R)}</td><td class="right">${money(net + tax, R)}</td></tr>`
    })
    .join('')
  const pd = data.payment_details
  const identifiers = pd?.identifier_values
    ? Object.entries(pd.identifier_values)
        .map(([k, v]) => `<div><strong>${esc(k)}:</strong> ${esc(v)}</div>`)
        .join('')
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body><div class="wrap">
    <div class="firm">
      <div><h1>${esc(data.firm_name ?? '')}</h1>${firmIdentityHtml(data.firm_identity)}</div>
      <div class="small right"><div class="doc-title">${esc(title)}</div><div>${esc(data.bill_number ?? '')}</div></div>
    </div>
    <div class="row">
      <div><strong>${esc(data.client_name ?? '')}</strong></div>
      <div class="small right">
        <div><strong>Our ref:</strong> ${esc(data.matter_number ?? '')}</div>
        <div><strong>Issue date:</strong> ${esc(data.issue_date ?? '')}</div>
        <div><strong>Terms:</strong> ${esc(data.terms_days ?? '')} days</div>
      </div>
    </div>
    <h2>Summary</h2>
    <table>
      <thead><tr><th>Description</th><th class="right">Net</th><th class="right">Tax</th><th class="right">Gross</th></tr></thead>
      <tbody>${lineRows}
        <tr class="grand"><td>Total</td><td></td><td></td><td class="right">${money(data.total, R)}</td></tr>
      </tbody>
    </table>
    ${
      data.interest_statement?.annual_rate_pct !== undefined
        ? `<div class="muted small" style="margin-top:10px">Interest accrues on overdue amounts at ${esc(data.interest_statement.annual_rate_pct)}% per annum as stated on this bill.</div>`
        : ''
    }
    ${
      pd
        ? `<h2>Payment instructions</h2><div class="small">
             <div><strong>Account name:</strong> ${esc(pd.account_holder_name ?? '')}</div>
             <div><strong>Bank:</strong> ${esc(pd.bank_name ?? '')}</div>
             ${identifiers}
             <div><strong>Reference:</strong> ${esc(data.matter_number ?? '')}</div>
           </div>`
        : `<h2>Payment instructions</h2><div class="small muted">Please contact our office for payment instructions.</div>`
    }
    ${
      data.notice?.text
        ? `<h2>${esc(data.notice.heading ?? 'Please note')}</h2><div class="small">${esc(data.notice.text)}</div>`
        : ''
    }
  </div></body></html>`
}

async function presentBillDespatch(
  data: BillDespatchRendering,
  ctx: PresentContext,
): Promise<PresentedMessage> {
  if (!ctx.htmlToPdf) {
    // a message that promises a document is NEVER sent without it
    throw new Error(
      'converter_not_configured: the bill document needs the HTML-to-PDF converter and none is bound',
    )
  }
  const pdf = await ctx.htmlToPdf(billDocumentHtml(data))
  const title = (data.document_title ?? '').trim() || 'Invoice'
  const number = (data.bill_number ?? 'bill').replace(/[^\w.\-() ]+/g, '_')
  const subject = `${title} ${data.bill_number ?? ''}${data.matter_number ? ` — ${data.matter_number}` : ''}`.trim()
  return {
    subject,
    text: `Please find attached ${title.toLowerCase()} ${data.bill_number ?? ''} for matter ${data.matter_number ?? ''}. Payment instructions are on the invoice.`,
    attachments: [
      {
        filename: `${title} ${number}.pdf`,
        contentType: 'application/pdf',
        contentBase64: pdf.toString('base64'),
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// The client-money receipt email (0055 batch): the printable receipt as a
// PDF attachment, composed from the self-contained rendering the email
// operation stores. A message that promises a document is never sent
// without it.
// ---------------------------------------------------------------------------

export interface ReceiptEmailRendering {
  document: 'money_receipt_email'
  firm_name?: string
  receipt_number?: string
  received_date?: string
  amount?: number
  method?: string
  matter_number?: string
  matter_title?: string
  client_name?: string
  payer_description?: string | null
  /** Pack wording via strings.receipt_title; absent = the neutral title. */
  document_title?: string | null
  regional?: { currency?: string; locale?: string } | null
  firm_identity?: FirmIdentity | null
}

function receiptDocumentHtml(data: ReceiptEmailRendering): string {
  const R = regionalFrom(data.regional)
  const title = (data.document_title ?? '').trim() || 'Receipt'
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body><div class="wrap">
    <div class="firm">
      <div><h1>${esc(data.firm_name ?? '')}</h1>${firmIdentityHtml(data.firm_identity)}</div>
      <div class="small right"><div class="doc-title">${esc(title)}</div><div>${esc(data.receipt_number ?? '')}</div></div>
    </div>
    <div class="row">
      <div><strong>${esc(data.client_name ?? '')}</strong></div>
      <div class="small right">
        <div><strong>Our ref:</strong> ${esc(data.matter_number ?? '')}</div>
        <div><strong>Date received:</strong> ${esc(data.received_date ?? '')}</div>
      </div>
    </div>
    <h2>Receipt</h2>
    <table>
      <thead><tr><th>Matter</th><th>Received from</th><th class="right">Method</th><th class="right">Amount</th></tr></thead>
      <tbody>
        <tr>
          <td>${esc(data.matter_number ?? '')} — ${esc(data.matter_title ?? '')}</td>
          <td>${esc(data.payer_description ?? data.client_name ?? '')}</td>
          <td class="right">${esc(String(data.method ?? '').replace(/_/g, ' '))}</td>
          <td class="right">${money(data.amount, R)}</td>
        </tr>
        <tr class="grand"><td>Total received</td><td></td><td></td><td class="right">${money(data.amount, R)}</td></tr>
      </tbody>
    </table>
    <div class="muted small" style="margin-top:10px">This receipt records money received into the firm's client account for the matter above.</div>
  </div></body></html>`
}

// The payment requisition as a standalone document: who is paid, from which
// ledger and firm account, how much, why, who asked, who authorised, and
// (once executed) the bank's own reference — the same facts the requisition
// screen shows, rendered for the converter so the download is a real PDF.
export interface RequisitionRendering {
  payment: Record<string, unknown>
  authorisations: Record<string, unknown>[]
  regional?: { currency?: string; locale?: string } | null
}

/** Bank-detail labels come from the stored keys themselves (pack-declared
 *  field keys, or legacy fixed keys): very short keys read as initialisms. */
export function bankFieldLabel(k: string): string {
  const words = k.replace(/_/g, ' ')
  return k.replace(/_/g, '').length <= 3 ? words.toUpperCase() : words
}

/** A stored bank-details block rendered generically: the account name first,
 *  then every identifier exactly as captured — never assembled. */
export function bankDetailsText(v: unknown): string {
  const b = (v ?? {}) as Record<string, unknown>
  const parts: string[] = []
  if (typeof b.account_name === 'string' && b.account_name.trim() !== '') parts.push(b.account_name.trim())
  for (const [k, val] of Object.entries(b)) {
    if (k === 'account_name' || val === null || val === undefined || String(val).trim() === '') continue
    parts.push(`${bankFieldLabel(k)} ${String(val).trim()}`)
  }
  return parts.join(' · ')
}

function personName(v: unknown): string {
  const n = (v ?? {}) as { given?: string; family?: string; display?: string }
  return n.display ?? [n.given, n.family].filter(Boolean).join(' ')
}

function fmtStamp(v: unknown): string {
  if (!v) return '—'
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(DISPLAY_LOCALE, { hour12: false })
}

export function requisitionDocumentHtml(data: RequisitionRendering): string {
  const r = data.payment
  const R = regionalFrom(data.regional)
  const payer = (r.account_bank_identifiers ?? {}) as Record<string, string>
  const payerText = Object.entries(payer)
    .map(([k, v]) => `${bankFieldLabel(k)} ${v}`)
    .join(' · ')
  const state = String(r.state)
  const docTitle = String(r.method) === 'eft' ? 'EFT Requisition' : 'Payment Requisition'
  const rows: [string, string][] = [
    ['Payment / EFT number', r.payment_number ? String(r.payment_number) : `Requisition #${String(r.id)} — the payment number is allocated when the payment executes`],
    ['Status', state.replace(/_/g, ' ')],
    ['Matter', `${String(r.matter_number)} — ${String(r.matter_title)}${r.prior_reference ? ` (old file ${String(r.prior_reference)})` : ''}`],
    ['Client', String(r.client_name || '—')],
    ['Ledger', String(r.ledger_number)],
    ['Paid from (the firm’s client account)', `${String(r.account_name)}${payerText ? ` · ${payerText}` : ' · — bank identifiers not recorded'}`],
    ['Payee', String(r.payee_name ?? r.payee_description ?? '—')],
    ['Payee bank details',
      bankDetailsText(r.payee_bank_details)
        || bankDetailsText(r.firm_payee_details)
        || '— (not recorded)'],
    ['Amount', money(r.amount, R)],
    ['Method', String(r.method).replace(/_/g, ' ')],
    ['Purpose', String(r.purpose) === 'general' ? String(r.reason) : `${String(r.purpose).replace(/_/g, ' ')} — ${String(r.reason)}`],
    ['Requested by', `${personName(r.requester_name)} · ${fmtStamp(r.created_at)}`],
    ['Submitted', r.submitted_at ? fmtStamp(r.submitted_at) : '—'],
    ['Authorised', data.authorisations.length
      ? data.authorisations.map((a) => `${a.decision === 'approved' ? 'Approved' : 'Rejected'} by ${personName(a.person_name)} · ${fmtStamp(a.decided_at)}`).join('; ')
      : '— (awaiting)'],
    ['Executed', r.executed_at ? fmtStamp(r.executed_at) : '— (not yet paid)'],
    ['Bank transaction reference', String(r.external_reference ?? '— (entered at execution)')],
  ]
  const rowHtml = rows
    .map(([k, v]) => `<tr><th style="width:200px;text-align:left;vertical-align:top">${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body><div class="wrap">
    <div class="firm">
      <div><h1>${esc(String(r.firm_name ?? ''))}</h1></div>
      <div class="small right"><div class="doc-title">${docTitle}</div><div>${esc(r.payment_number ? String(r.payment_number) : `#${String(r.id)}`)}</div></div>
    </div>
    <table>${rowHtml}</table>
    <table style="margin-top:36px"><tr>
      <td style="width:50%;border-top:1px solid #333;padding-top:6px">Prepared / requested — signature &amp; date</td>
      <td style="width:8%"></td>
      <td style="border-top:1px solid #333;padding-top:6px">Authorised — signature &amp; date</td>
    </tr></table>
    <div class="muted small" style="margin-top:10px">The register is the record; this document is its paper face.</div>
  </div></body></html>`
}

// The consolidated EFT requisition for a held-funds run: every COMPLETED
// transfer on one form — grouped by the client account the money left, with
// each matter's bill, receipt and payment numbers and who approved it, the
// firm's own receiving details, and one grand total for the one bank
// transfer that covers them all.
export interface RunRequisitionRendering {
  run: Record<string, unknown>
  items: Record<string, unknown>[]
  excluded: number
  firm_payee_details: unknown
  regional?: { currency?: string; locale?: string } | null
}

export function runRequisitionDocumentHtml(data: RunRequisitionRendering): string {
  const R = regionalFrom(data.regional)
  const run = data.run
  const total = data.items.reduce((s, i) => s + Number(i.amount ?? 0), 0)
  const byAccount = new Map<number, Record<string, unknown>[]>()
  for (const i of data.items) {
    const a = Number(i.account)
    if (!byAccount.has(a)) byAccount.set(a, [])
    byAccount.get(a)!.push(i)
  }
  const sections = [...byAccount.values()]
    .map((items) => {
      const first = items[0]
      const payer = (first.account_bank_identifiers ?? {}) as Record<string, string>
      const payerText = Object.entries(payer)
        .map(([k, v]) => `${bankFieldLabel(k)} ${v}`)
        .join(' · ')
      const subtotal = items.reduce((s, i) => s + Number(i.amount ?? 0), 0)
      const rows = items
        .map((i) => {
          const approvals = Array.isArray(i.approvals)
            ? (i.approvals as { name?: unknown; at?: unknown }[])
                .map((a) => `${personName(a.name)} · ${fmtStamp(a.at)}`)
                .join('; ')
            : '—'
          return `<tr>
            <td>${esc(String(i.matter_number ?? ''))} — ${esc(String(i.matter_title ?? ''))}</td>
            <td>${esc(String(i.ledger_number ?? ''))}</td>
            <td>${esc(String(i.bill_number ?? ''))}</td>
            <td>${esc(String(i.receipt_number ?? '—'))}</td>
            <td>${esc(String(i.payment_number ?? '—'))}</td>
            <td>${esc(approvals)}</td>
            <td class="right">${money(i.amount, R)}</td>
          </tr>`
        })
        .join('')
      return `<h2>Paid from — ${esc(String(first.account_name ?? ''))}${payerText ? ` · ${esc(payerText)}` : ''}</h2>
        <table>
          <thead><tr><th>Matter</th><th>Ledger</th><th>Bill</th><th>Receipt</th><th>Payment</th><th>Approved</th><th class="right">Amount</th></tr></thead>
          <tbody>${rows}
            ${byAccount.size > 1 ? `<tr class="grand"><td colspan="6">Account subtotal</td><td class="right">${money(subtotal, R)}</td></tr>` : ''}
          </tbody>
        </table>`
    })
    .join('')
  const paidTo = bankDetailsText(data.firm_payee_details)
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body><div class="wrap">
    <div class="firm">
      <div><h1>${esc(String(run.firm_name ?? ''))}</h1></div>
      <div class="small right"><div class="doc-title">EFT Requisition</div><div>Held-funds run #${esc(String(run.id ?? ''))} · ${fmtStamp(run.run_at)}</div></div>
    </div>
    <div class="row">
      <div><strong>Paid to (the firm's account):</strong> ${esc(paidTo || '— (payment details not configured)')}</div>
      <div class="small right"><strong>Completed transfers:</strong> ${String(data.items.length)}</div>
    </div>
    ${sections}
    <table><tbody>
      <tr class="grand"><td>Total — one transfer to the firm's account</td><td class="right">${money(total, R)}</td></tr>
    </tbody></table>
    ${
      data.excluded > 0
        ? `<div class="muted small" style="margin-top:8px">${String(data.excluded)} item(s) on this run are not included — refused, or still awaiting authorisation; they appear on the run page with their reasons.</div>`
        : ''
    }
    <table style="margin-top:36px"><tr>
      <td style="width:50%;border-top:1px solid #333;padding-top:6px">Prepared — signature &amp; date</td>
      <td style="width:8%"></td>
      <td style="border-top:1px solid #333;padding-top:6px">Authorised — signature &amp; date</td>
    </tr></table>
    <div class="muted small" style="margin-top:10px">Each transfer above passed its own authorisation before executing. The register is the record; this document is its paper face.</div>
  </div></body></html>`
}

// The client-money ledger as a document: the header and every line in entry
// order with running balances — the ledger screen's facts, rendered for the
// converter so the printout for the file is a real PDF.
export interface LedgerRendering {
  ledger: Record<string, unknown>
  lines: Record<string, unknown>[]
  regional?: { currency?: string; locale?: string } | null
}

export function ledgerDocumentHtml(data: LedgerRendering): string {
  const l = data.ledger
  const R = regionalFrom(data.regional)
  const payer = (l.bank_identifiers ?? {}) as Record<string, string>
  const payerText = Object.entries(payer)
    .map(([k, v]) => `${bankFieldLabel(k)} ${v}`)
    .join(' · ')
  const lineRows = data.lines
    .map((x) => {
      const amount = Number(x.signed_amount ?? 0)
      return `<tr>
        <td>${esc(String(x.entry_no ?? ''))}</td>
        <td>${esc(String(x.effective_date ?? ''))}</td>
        <td>${esc(String(x.txn_kind ?? '').replace(/_/g, ' '))}${x.reverses ? ' (reversal)' : ''}</td>
        <td>${esc(String(x.reason ?? ''))}</td>
        <td class="right">${money(amount, R)}</td>
        <td class="right">${money(x.running_balance, R)}</td>
      </tr>`
    })
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body><div class="wrap">
    <div class="firm">
      <div><h1>${esc(String(l.firm_name ?? ''))}</h1></div>
      <div class="small right"><div class="doc-title">Client Money Ledger</div><div>${esc(String(l.ledger_number ?? ''))}</div></div>
    </div>
    <div class="row">
      <div>
        <div><strong>${esc(String(l.client_name || ''))}</strong></div>
        <div class="small">${l.matter_number ? `${esc(String(l.matter_number))} — ${esc(String(l.title ?? ''))}` : esc(String(l.ledger_kind ?? '').replace(/_/g, ' '))}</div>
      </div>
      <div class="small right">
        <div><strong>Account:</strong> ${esc(String(l.account_name ?? ''))}</div>
        ${payerText ? `<div>${esc(payerText)}</div>` : ''}
        <div><strong>Status:</strong> ${esc(String(l.status ?? ''))}</div>
      </div>
    </div>
    <h2>Ledger</h2>
    <table>
      <thead><tr><th>#</th><th>Date</th><th>Kind</th><th>Detail</th><th class="right">Amount</th><th class="right">Balance</th></tr></thead>
      <tbody>
        ${lineRows}
        <tr class="grand"><td colspan="4">Balance</td><td></td><td class="right">${money(l.balance, R)}</td></tr>
      </tbody>
    </table>
    <div class="muted small" style="margin-top:10px">Every movement on this ledger in entry order. The register is the record; this document is its paper face.</div>
  </div></body></html>`
}

async function presentReceiptEmail(
  data: ReceiptEmailRendering,
  ctx: PresentContext,
): Promise<PresentedMessage> {
  if (!ctx.htmlToPdf) {
    throw new Error(
      'converter_not_configured: the receipt document needs the HTML-to-PDF converter and none is bound',
    )
  }
  const pdf = await ctx.htmlToPdf(receiptDocumentHtml(data))
  const title = (data.document_title ?? '').trim() || 'Receipt'
  const number = (data.receipt_number ?? 'receipt').replace(/[^\w.\-() ]+/g, '_')
  return {
    subject: `Receipt ${data.receipt_number ?? ''}${data.matter_number ? ` — ${data.matter_number}` : ''}`.trim(),
    text: `Please find attached your ${title.toLowerCase()} ${data.receipt_number ?? ''} for matter ${data.matter_number ?? ''}.`,
    attachments: [
      {
        filename: `Receipt ${number}.pdf`,
        contentType: 'application/pdf',
        contentBase64: pdf.toString('base64'),
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export type Presenter = (
  data: never,
  ctx: PresentContext,
) => PresentedMessage | Promise<PresentedMessage>

const PRESENTERS: Record<string, (data: unknown, ctx: PresentContext) => PresentedMessage | Promise<PresentedMessage>> = {
  bill_reminder: (d) => presentReminder(d as ReminderRendering),
  instalment_notice: (d) => presentInstalment(d as InstalmentRendering),
  scheduled_report: (d) => presentScheduledReport(d as ScheduledReportRendering),
  bill_despatch: (d, ctx) => presentBillDespatch(d as BillDespatchRendering, ctx),
  money_receipt: (d, ctx) => presentReceiptEmail(d as ReceiptEmailRendering, ctx),
}

/** Null = no presenter: the transport's typed refusal stands. */
export function presenterFor(
  purpose: string,
): ((data: unknown, ctx: PresentContext) => PresentedMessage | Promise<PresentedMessage>) | null {
  return PRESENTERS[purpose] ?? null
}
