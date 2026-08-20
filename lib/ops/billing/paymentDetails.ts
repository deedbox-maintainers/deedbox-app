// Payment details on bills; the send ceremony. Versions are append-only;
// the governing version is the latest approved (the ONE resolver
// deedbox.governing_payment_details() reads it); every write registers
// `payment_details.changed` privileged with full before/after. With the
// approval setting on, a new version parks pending until a DIFFERENT
// authorised user approves (the schema enforces the separation); until
// then the prior version keeps governing. The send ceremony: the caller
// names recipients and confirms deliberately — no one-click send exists;
// the rendering resolves the payment block AT DESPATCH through the one
// resolver, all-or-nothing (an incomplete block is absent, never partial),
// and the despatch is registered with the exact artefact.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, settingBool, packString, firmRegional, firmIdentity, bankIdentifierKeys } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'

interface DetailsInput {
  accountHolderName: string
  bankName: string
  identifierValues: Record<string, string>
}

async function governingRow(tx: Tx): Promise<{
  id: number
  version_no: number
  account_holder_name: string
  bank_name: string
  identifier_values: Record<string, string>
} | null> {
  const r = await tx.query(
    `select id, version_no, account_holder_name, bank_name, identifier_values
       from deedbox.payment_details
      where state = 'approved' and superseded_at is null`,
  )
  return r.rowCount === 0 ? null : (r.rows[0] as never)
}

/**
 * Record a new payment-details version. The payee is captured exactly as
 * typed, never assembled.
 */
export async function savePaymentDetails(
  p: Principal,
  input: DetailsInput,
): Promise<{ id: number; state: 'approved' | 'pending' }> {
  requireStaff(p)
  if (!input.accountHolderName.trim() || !input.bankName.trim()) {
    throw new OperationRefused('incomplete', 'the account holder and bank names are both required')
  }
  return withPrincipal(p, async (tx) => {
    const keys = await bankIdentifierKeys(tx, p.firm)
    if (keys) {
      for (const k of keys) {
        if (!input.identifierValues[k]?.trim()) {
          throw new OperationRefused('incomplete', `the pack requires the ${k} identifier`)
        }
      }
      for (const given of Object.keys(input.identifierValues)) {
        if (!keys.includes(given)) {
          throw new OperationRefused('unknown_field', `the pack declares no ${given} identifier`)
        }
      }
    } else if (Object.keys(input.identifierValues).length === 0) {
      throw new OperationRefused('incomplete', 'at least one account identifier is required')
    }
    const before = await governingRow(tx)
    const needsApproval = await settingBool(tx, 'billing.payment_details_require_approval')
    if (needsApproval) {
      const pending = await tx.query(
        `select 1 from deedbox.payment_details where state = 'pending'`,
      )
      if (pending.rowCount! > 0) {
        throw new OperationRefused('pending_exists', 'a version already awaits approval — decide it first')
      }
      const r = await tx.query(
        `insert into deedbox.payment_details
           (account_holder_name, bank_name, identifier_values, state, created_by)
         values ($1, $2, $3, 'pending', $4) returning id`,
        [input.accountHolderName, input.bankName, JSON.stringify(input.identifierValues), p.id],
      )
      await emitRegister(tx, p, {
        kind: 'payment_details.changed',
        subjectType: 'payment_details',
        subject: r.rows[0].id as number,
        privileged: true,
        detail: {
          before,
          after: { ...input, state: 'pending' },
        },
      })
      return { id: r.rows[0].id as number, state: 'pending' as const }
    }
    // the governing index is UNIQUE (one approved-unsuperseded row at any
    // instant): the predecessor supersedes BEFORE the successor approves
    if (before) {
      await tx.query(
        `update deedbox.payment_details set superseded_at = now() where id = $1`,
        [before.id],
      )
    }
    const r = await tx.query(
      `insert into deedbox.payment_details
         (account_holder_name, bank_name, identifier_values, state, created_by, approved_by, approved_at)
       values ($1, $2, $3, 'approved', $4, $4, now()) returning id`,
      [input.accountHolderName, input.bankName, JSON.stringify(input.identifierValues), p.id],
    )
    await emitRegister(tx, p, {
      kind: 'payment_details.changed',
      subjectType: 'payment_details',
      subject: r.rows[0].id as number,
      privileged: true,
      detail: { before, after: { ...input, state: 'approved' } },
    })
    return { id: r.rows[0].id as number, state: 'approved' as const }
  })
}

/** Approve the pending version; it starts governing now. */
export async function approvePaymentDetails(
  p: Principal,
  input: { version: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const before = await governingRow(tx)
    const pending = await tx.query(
      `select 1 from deedbox.payment_details where id = $1 and state = 'pending'`,
      [input.version],
    )
    if (pending.rowCount === 0) {
      throw new OperationRefused('not_pending', 'no pending version by that id')
    }
    // one approved-unsuperseded row at any instant: predecessor first
    if (before) {
      await tx.query(
        `update deedbox.payment_details set superseded_at = now() where id = $1`,
        [before.id],
      )
    }
    const r = await tx.query(
      `update deedbox.payment_details
          set state = 'approved', approved_by = $2, approved_at = now()
        where id = $1 and state = 'pending'
        returning account_holder_name, bank_name, identifier_values`,
      [input.version, p.id],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_pending', 'no pending version by that id')
    await emitRegister(tx, p, {
      kind: 'payment_details.changed',
      subjectType: 'payment_details',
      subject: input.version,
      privileged: true,
      detail: {
        before,
        after: {
          accountHolderName: r.rows[0].account_holder_name,
          bankName: r.rows[0].bank_name,
          identifierValues: r.rows[0].identifier_values,
          state: 'approved',
        },
      },
    })
  })
}

interface SendPreview {
  bill: number
  billNumber: string
  suggestedRecipient: string | null
  paymentDetailsComplete: boolean
  rendering: unknown
}

/** The despatch-time rendering: issued content + the governing block, all-or-nothing. */
async function despatchRenderingInTx(
  tx: Tx,
  firm: number,
  billId: number,
): Promise<{ content: unknown; complete: boolean; billNumber: string; matter: number }> {
  const bill = await tx.query(
    `select b.id, b.bill_number, b.matter, b.state, b.rendered_artefact,
            m.matter_number, pn.full_name as client_name,
            (select name from deedbox.firm where id = $2) as firm_name
       from deedbox.bill b
       join deedbox.matter m on m.id = b.matter
       left join deedbox.party_name pn
         on pn.party = b.payer_party and pn.name_kind = 'current'
      where b.id = $1`,
    [billId, firm],
  )
  if (bill.rowCount === 0) throw new OperationRefused('not_found', 'bill not found')
  if (bill.rows[0].state !== 'issued') {
    throw new OperationRefused('not_issued', 'only issued bills are sent')
  }
  const artefact = await tx.query(
    `select content_ref from deedbox.stored_artefact where id = $1::bigint`,
    [bill.rows[0].rendered_artefact],
  )
  const issued =
    typeof artefact.rows[0].content_ref === 'string'
      ? JSON.parse(artefact.rows[0].content_ref as string)
      : artefact.rows[0].content_ref
  const governing = await governingRow(tx)
  const complete =
    governing !== null &&
    governing.account_holder_name.trim() !== '' &&
    governing.bank_name.trim() !== '' &&
    Object.keys(governing.identifier_values ?? {}).length > 0
  const content = {
    ...issued,
    // the identity a finished message needs: enriched HERE so
    // the send-ceremony preview and the delivered document can never
    // diverge — the presenter renders from this content alone
    bill_number: bill.rows[0].bill_number,
    matter_number: bill.rows[0].matter_number,
    client_name: bill.rows[0].client_name ?? null,
    firm_name: bill.rows[0].firm_name,
    // the document's name is pack wording (strings.bill_title) with the
    // engine's neutral fallback; money renders in the firm's own currency;
    // the firm's trading identity appears when the firm has recorded it
    document_title: (await packString(tx, firm, 'strings.bill_title')) ?? 'Invoice',
    regional: await firmRegional(tx, firm),
    firm_identity: await firmIdentity(tx, firm),
    // The block resolves AT DESPATCH through the one resolver —
    // all-or-nothing; an incomplete block is ABSENT, never partial
    payment_details: complete
      ? {
          account_holder_name: governing!.account_holder_name,
          bank_name: governing!.bank_name,
          identifier_values: governing!.identifier_values,
          reference: 'matter_reference',
        }
      : null,
  }
  return {
    content,
    complete,
    billNumber: bill.rows[0].bill_number as string,
    matter: bill.rows[0].matter as number,
  }
}

/** View without sending: the exact despatch rendering. */
export async function previewBillSend(p: Principal, input: { bill: number }): Promise<SendPreview> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await despatchRenderingInTx(tx, p.firm, input.bill)
      const contact = await tx.query(
        `select c.value from deedbox.contact_point c
           join deedbox.matter m on m.client_party = c.party
          where m.id = $1 and c.kind = 'email' and c.deleted_at is null
          order by c.is_primary desc, c.id limit 1`,
        [r.matter],
      )
      return {
        bill: input.bill,
        billNumber: r.billNumber,
        suggestedRecipient: contact.rowCount! > 0 ? (contact.rows[0].value as string) : null,
        paymentDetailsComplete: r.complete,
        rendering: r.content,
      }
    },
    { readOnly: true },
  )
}

/**
 * The send ceremony. The caller names every recipient and
 * confirms deliberately; the despatch stores the exact artefact, queues one
 * outbound message per recipient, and registers the send.
 */
export async function sendBill(
  p: Principal,
  input: { bill: number; recipients: string[]; confirmed: boolean },
): Promise<{ artefact: number; queued: number; paymentDetailsIncluded: boolean }> {
  requireStaff(p)
  if (!input.confirmed) {
    throw new OperationRefused(
      'not_confirmed',
      'sending requires the deliberate confirmation — no one-click send exists',
    )
  }
  const recipients = input.recipients.map((r) => r.trim()).filter((r) => r !== '')
  if (recipients.length === 0) {
    throw new OperationRefused('no_recipients', 'name every recipient before sending')
  }
  return withPrincipal(p, async (tx) => {
    const r = await despatchRenderingInTx(tx, p.firm, input.bill)
    const content = JSON.stringify(r.content)
    const artefact = await tx.query(
      `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
       values ('bill_despatch_rendering', $1, $2, 'application/json', $3) returning id`,
      [content, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)],
    )
    for (const recipient of recipients) {
      await tx.query(
        `insert into deedbox.outbound_message
           (channel, recipient, rendered_artefact, purpose, related_type, related)
         values ('email', $1, $2, 'bill_despatch', 'bill', $3)`,
        [recipient, String(artefact.rows[0].id), input.bill],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'bill',
      subject: input.bill,
      matter: r.matter,
      artefact: String(artefact.rows[0].id),
      detail: {
        sent_to: recipients,
        bill_number: r.billNumber,
        payment_details_included: r.complete,
      },
    })
    return {
      artefact: artefact.rows[0].id as number,
      queued: recipients.length,
      paymentDetailsIncluded: r.complete,
    }
  })
}
