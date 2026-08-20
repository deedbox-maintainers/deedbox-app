// Client money: record receipt, reverse transaction, and open ledger
// (automatic on a first receipt, or explicit). Every posting travels the
// posting protocol; every refusal of a money posting is captured, typed, in
// a separate committed transaction (runMoneyOperation). A receipt is one
// transaction: the transaction row (kind receipt) + its two posting lines,
// the receipt document with its gapless R- number and printable artefact,
// the instrument row (received) where the method is instrument-backed, and
// the register entry — commit, or nothing.
//
// Implementation notes: the pack's `money.payment_methods` declaration
// governs the valid method list and, via its per-method `instrument_backed`
// flag, which methods create an instrument row (the neutral default backs
// `cheque` only); per-method identifier values are stored on the receipt's
// rendering and validated against the pack's field schema where one is
// declared; the position-cache feed arrives with the reporting/jobs slice.

import type { Principal, Tx } from '@/lib/db'
import {
  withPrincipal,
  emitRegister,
  OperationRefused,
  MoneyPreconditionFailed,
  runMoneyOperation,
} from '@/lib/db'
import { requireStaff, requireCapability, packString, firmRegional, firmIdentity } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'

function cents(x: number | string): number {
  return Math.round(Number(x) * 100)
}

interface MethodRule {
  key: string
  instrumentBacked: boolean
  identifierFields: string[]
}

/** The FIRM'S pack's method catalogue; the neutral default backs cheques
 *  only. Firm-scoped like every pack lookup (the lesson: an
 *  unscoped active-version join picks up other firms' packs on any database
 *  hosting more than one). */
async function methodRules(tx: Tx, firm: number): Promise<MethodRule[]> {
  const r = await tx.query(
    `select d.body from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
       join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
      where d.rule_point = 'money.payment_methods'`,
    [firm],
  )
  const out: MethodRule[] = []
  for (const row of r.rows) {
    const b = row.body as {
      methods?: { key: string; instrument_backed?: boolean; identifier_fields?: string[] }[]
    }
    for (const m of b.methods ?? []) {
      out.push({
        key: m.key,
        instrumentBacked: m.instrument_backed ?? false,
        identifierFields: m.identifier_fields ?? [],
      })
    }
  }
  if (out.length === 0) {
    return [
      { key: 'electronic_transfer', instrumentBacked: false, identifierFields: [] },
      { key: 'card', instrumentBacked: false, identifierFields: [] },
      { key: 'cheque', instrumentBacked: true, identifierFields: [] },
      { key: 'cash', instrumentBacked: false, identifierFields: [] },
    ]
  }
  return out
}

/** The ledger for a (matter, account) pair, opened on first need. */
export async function ensureLedgerInTx(
  tx: Tx,
  p: Principal,
  matterId: number,
  accountId: number,
): Promise<{ id: number; created: boolean }> {
  const existing = await tx.query(
    `select id, status from deedbox.matter_ledger
      where matter = $1 and account = $2 and ledger_kind = 'client_matter'`,
    [matterId, accountId],
  )
  if (existing.rowCount! > 0) {
    if (existing.rows[0].status !== 'open') {
      // a receipt against a closed ledger is an integrity refusal —
      // captured, never silently rerouted; retried after a privileged reopen
      throw new MoneyPreconditionFailed(
        'integrity_refusal',
        'the ledger is closed — reopen it before receipting; settlement is never silently rerouted',
      )
    }
    return { id: existing.rows[0].id as number, created: false }
  }
  const r = await tx.query(
    `insert into deedbox.matter_ledger (account, matter) values ($1, $2) returning id`,
    [accountId, matterId],
  )
  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'matter_ledger',
    subject: r.rows[0].id as number,
    matter: matterId,
    detail: { account: accountId, opened_on_first_receipt: true },
  })
  return { id: r.rows[0].id as number, created: true }
}

export interface ReceiptInput {
  matter: number
  account: number
  amount: number
  method: string
  receivedDate?: string
  payerParty?: number
  payerDescription?: string
  /** Per-method identifier values (pack field schema). */
  identifiers?: Record<string, string>
  /** The instrument number, required for instrument-backed methods. */
  instrumentNumber?: string
}

/** Record a client-money receipt. */
export async function recordMoneyReceipt(
  p: Principal,
  input: ReceiptInput,
): Promise<{ receipt: number; receiptNumber: string; transaction: number; ledger: number }> {
  requireStaff(p)
  if (!(input.amount > 0)) throw new OperationRefused('bad_amount', 'a receipt is above zero')
  if (!input.payerParty && !input.payerDescription?.trim()) {
    throw new OperationRefused('payer_required', 'name the payer, or describe them')
  }
  return runMoneyOperation(
    p,
    { account: input.account, operation: 'record_receipt' },
    async (tx) => {
      await requireCapability(tx, p, 'money.receive')
      const rules = await methodRules(tx, p.firm)
      const rule = rules.find((m) => m.key === input.method)
      if (!rule) {
        // a programmatic attempt on an unavailable method is captured, never silent
        throw new MoneyPreconditionFailed(
          'method_unavailable',
          `the pack does not declare method ${input.method}`,
        )
      }
      for (const f of rule.identifierFields) {
        if (!input.identifiers?.[f]?.trim()) {
          throw new OperationRefused('incomplete', `the ${input.method} method requires the ${f} identifier`)
        }
      }
      if (rule.instrumentBacked && !input.instrumentNumber?.trim()) {
        throw new OperationRefused('incomplete', `the ${input.method} method requires the instrument number`)
      }
      const account = await tx.query(
        `select id, active from deedbox.client_account where id = $1`,
        [input.account],
      )
      if (account.rowCount === 0) throw new OperationRefused('not_found', 'client account not found')
      if (!account.rows[0].active) {
        throw new OperationRefused('account_inactive', 'the client account is not active')
      }
      if (input.payerParty) {
        // a payer id the client register does not hold refuses on screen in
        // these words — the foreign key would otherwise surface as a raw error
        const payer = await tx.query(
          `select 1 from deedbox.party where id = $1 and state = 'active' and deleted_at is null`,
          [input.payerParty],
        )
        if (payer.rowCount === 0) {
          throw new OperationRefused(
            'payer_unknown',
            'that payer is not in the client register — pick them from the suggestions, or describe the payer instead',
          )
        }
      }
      const ledger = await ensureLedgerInTx(tx, p, input.matter, input.account)

      // canonical order: the ledger lock first, then the receipt counter;
      // the posting's polymorphic source carries the receipt's own gapless
      // number (its numeric sequence) — the document row cannot exist before
      // its transaction, so the number IS the pre-insert provenance,
      // resolvable through money_receipt.receipt_number forever
      await tx.query(`select id from deedbox.matter_ledger where id = $1 for update`, [ledger.id])
      const num = await tx.query(`select deedbox.allocate_number('money_receipt') as n`)
      const receiptNumber = num.rows[0].n as string
      const receiptSeq = Number(receiptNumber.replace(/^\D+/, ''))
      const txn = await tx.query(
        `select deedbox.post_money_transaction(
           'receipt', coalesce($6::date, current_date), $1, 'money_receipt_number', $2,
           jsonb_build_array(
             jsonb_build_object('side','cash_book','account',$3::bigint,'signed_amount',$4::numeric),
             jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$5::bigint,'signed_amount',$4::numeric)
           )) as t`,
        [p.id, receiptSeq, input.account, input.amount, ledger.id, input.receivedDate ?? null],
      )
      const rendering = JSON.stringify({
        document: 'money_receipt',
        receipt_number: receiptNumber,
        amount: input.amount,
        method: input.method,
        identifiers: input.identifiers ?? {},
        payer_party: input.payerParty ?? null,
        payer_description: input.payerDescription ?? null,
      })
      const artefact = await tx.query(
        `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
         values ('money_receipt_rendering', $1, $2, 'application/json', $3) returning id`,
        [rendering, createHash('sha256').update(rendering).digest('hex'), Buffer.byteLength(rendering)],
      )
      const receipt = await tx.query(
        `insert into deedbox.money_receipt
           (matter_ledger, receipt_number, payer_party, payer_description, method,
            received_date, amount, transaction, printable_artefact)
         values ($1, $2, $3, $4, $5, coalesce($6::date, current_date), $7, $8, $9)
         returning id`,
        [
          ledger.id,
          receiptNumber,
          input.payerParty ?? null,
          input.payerDescription ?? null,
          input.method,
          input.receivedDate ?? null,
          input.amount,
          txn.rows[0].t,
          String(artefact.rows[0].id),
        ],
      )
      if (rule.instrumentBacked) {
        // the receipt document is insert-only and cannot learn its
        // instrument after birth; the instrument's source pointer IS the
        // linkage (source_type money_receipt, source = the receipt id)
        await tx.query(
          `insert into deedbox.instrument
             (account, direction, instrument_kind, number, amount, state, source_type, source,
              transaction, stale_after)
           values ($1, 'inbound', $2, $3, $4, 'received', 'money_receipt', $5, $6,
                   current_date + 180)`,
          [
            input.account,
            input.method,
            input.instrumentNumber,
            input.amount,
            receipt.rows[0].id,
            txn.rows[0].t,
          ],
        )
      }
      await emitRegister(tx, p, {
        kind: 'money.transaction_posted',
        subjectType: 'money_transaction',
        subject: txn.rows[0].t as number,
        matter: input.matter,
        detail: {
          kind: 'receipt',
          amount: input.amount,
          method: input.method,
          receipt_number: receiptNumber,
        },
      })
      return {
        receipt: receipt.rows[0].id as number,
        receiptNumber,
        transaction: txn.rows[0].t as number,
        ledger: ledger.id,
      }
    },
  )
}

/**
 * Reverse a whole transaction. Corrections are full reversals
 * plus fresh correct entries, never edits. Staff reversals of authorised
 * kinds demand an approved authorisation row; dishonour reversals are
 * system-posted on the bank's authority (the dishonour operation drives those).
 */
export async function reverseMoneyTransaction(
  p: Principal,
  input: { transaction: number; reason: string; authorisation?: number },
): Promise<{ reversal: number }> {
  requireStaff(p)
  if (!input.reason.trim()) {
    throw new OperationRefused('reason_required', 'a reversal always carries its reason')
  }
  const target = await withPrincipal(
    p,
    async (tx) => {
      const t = await tx.query(
        `select t.id, t.txn_kind,
                (select l.account from deedbox.ledger_line l
                  where l.transaction = t.id limit 1) as account,
                (select l.matter_ledger from deedbox.ledger_line l
                  where l.transaction = t.id and l.matter_ledger is not null limit 1) as ledger,
                exists (select 1 from deedbox.money_transaction r where r.reverses = t.id) as reversed
           from deedbox.money_transaction t where t.id = $1`,
        [input.transaction],
      )
      if (t.rowCount === 0) throw new OperationRefused('not_found', 'transaction not found')
      if (t.rows[0].reversed) {
        throw new OperationRefused('already_reversed', 'a transaction reverses at most once')
      }
      if (t.rows[0].txn_kind === 'reversal') {
        throw new OperationRefused('not_reversible', 'a reversal is never itself reversed')
      }
      return t.rows[0] as { id: number; txn_kind: string; account: number; ledger: number | null }
    },
    { readOnly: true },
  )
  return runMoneyOperation(
    p,
    {
      account: target.account,
      matterLedger: target.ledger ?? undefined,
      operation: 'reverse_transaction',
    },
    async (tx) => {
      await requireCapability(tx, p, 'money.record_payment')
      const lines = await tx.query(
        `select side, account, matter_ledger, signed_amount from deedbox.ledger_line
          where transaction = $1 order by id`,
        [input.transaction],
      )
      const mirrored = lines.rows.map((l) => ({
        side: l.side,
        account: l.account,
        matter_ledger: l.matter_ledger,
        signed_amount: -Number(l.signed_amount),
      }))
      const txn = await tx.query(
        `select deedbox.post_money_transaction(
           'reversal', current_date, $1, 'money_transaction', $2, $3::jsonb, $4, $5, $6) as t`,
        [
          p.id,
          input.transaction,
          JSON.stringify(mirrored),
          input.reason,
          input.authorisation ?? null,
          input.transaction,
        ],
      )
      const matter = await tx.query(
        `select ml.matter from deedbox.ledger_line l
          join deedbox.matter_ledger ml on ml.id = l.matter_ledger
         where l.transaction = $1 and l.matter_ledger is not null limit 1`,
        [input.transaction],
      )
      await emitRegister(tx, p, {
        kind: 'money.transaction_posted',
        subjectType: 'money_transaction',
        subject: txn.rows[0].t as number,
        matter: matter.rowCount! > 0 ? (matter.rows[0].matter as number) : undefined,
        reason: input.reason,
        detail: { kind: 'reversal', reverses: input.transaction },
      })
      return { reversal: txn.rows[0].t as number }
    },
  )
}

/**
 * The receipt send ceremony (0055 batch): the caller names every recipient
 * and confirms deliberately — no one-click send exists. One outbound message
 * per recipient carries a self-contained rendering the presenter turns into
 * the receipt PDF; a message promising a document is never sent without it.
 * Mirrors the bill despatch ceremony exactly.
 */
export async function emailReceipt(
  p: Principal,
  input: { receipt: number; recipients: string[]; confirmed: boolean },
): Promise<{ queued: number }> {
  requireStaff(p)
  if (!input.confirmed) {
    throw new OperationRefused('not_confirmed', 'confirm the recipients before sending')
  }
  const recipients = input.recipients.map((r) => r.trim()).filter((r) => r !== '')
  if (recipients.length === 0) {
    throw new OperationRefused('no_recipients', 'name every recipient before sending')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.receive')
    const r = await tx.query(
      `select mr.id, mr.receipt_number, mr.received_date::text as received_date, mr.amount,
              mr.method, mr.payer_description,
              m.id as matter_id, m.matter_number, m.title as matter_title,
              cp.display_name as client_name, f.name as firm_name
         from deedbox.money_receipt mr
         join deedbox.matter_ledger ml on ml.id = mr.matter_ledger
         join deedbox.matter m on m.id = ml.matter
         join deedbox.party cp on cp.id = m.client_party
         join deedbox.firm f on f.id = $2
        where mr.id = $1`,
      [input.receipt, p.firm],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'receipt not found')
    const row = r.rows[0]
    const rendering = JSON.stringify({
      document: 'money_receipt_email',
      firm_name: row.firm_name,
      receipt_number: row.receipt_number,
      received_date: row.received_date,
      amount: Number(row.amount),
      method: row.method,
      matter_number: row.matter_number,
      matter_title: row.matter_title,
      client_name: row.client_name,
      payer_description: row.payer_description,
      // pack wording, the firm's own currency and its trading identity —
      // enriched at queue time exactly as the bill despatch does
      document_title: (await packString(tx, p.firm, 'strings.receipt_title')) ?? 'Receipt',
      regional: await firmRegional(tx, p.firm),
      firm_identity: await firmIdentity(tx, p.firm),
    })
    const artefact = await tx.query(
      `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
       values ('money_receipt_email_rendering', $1, $2, 'application/json', $3) returning id`,
      [rendering, createHash('sha256').update(rendering).digest('hex'), Buffer.byteLength(rendering)],
    )
    for (const recipient of recipients) {
      await tx.query(
        `insert into deedbox.outbound_message
           (channel, recipient, rendered_artefact, purpose, related_type, related)
         values ('email', $1, $2, 'money_receipt', 'money_receipt', $3)`,
        [recipient, String(artefact.rows[0].id), input.receipt],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'money_receipt',
      subject: input.receipt,
      matter: row.matter_id as number,
      detail: { emailed_to: recipients, receipt_number: row.receipt_number },
    })
    return { queued: recipients.length }
  })
}
