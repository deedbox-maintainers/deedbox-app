// Credit notes, write-offs, disputes and billing holds. Credit notes and
// write-offs are permanent records whose effect lives in the bill journal;
// corrections are reversal entries. The dispute record drives the reminder
// stop — and its resolution the automatic resume — while the bill stays
// issued.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'

/** Advisory lock class for credit notes (append-only, so never row-lockable). */
async function lockCreditNote(tx: Tx, noteId: number): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(4202, $1::int)`, [noteId])
}

async function issuedBill(tx: Tx, billId: number) {
  const b = await tx.query(
    `select id, matter, state from deedbox.bill where id = $1 for update`,
    [billId],
  )
  if (b.rowCount === 0) throw new OperationRefused('not_found', 'bill not found')
  if (b.rows[0].state !== 'issued') {
    throw new OperationRefused('not_issued', 'only issued bills take post-issue entries')
  }
  return b.rows[0] as { id: number; matter: number }
}

async function stopReminderIfPaid(tx: Tx, billId: number): Promise<void> {
  const o = await tx.query(`select deedbox.bill_outstanding($1) as o`, [billId])
  if (Number(o.rows[0].o) === 0) {
    await tx.query(
      `update deedbox.bill_reminder_state set status = 'stopped_paid'
        where bill = $1 and status = 'running'`,
      [billId],
    )
  }
}

/** Create a credit note; gapless number inside the transaction. */
export async function createCreditNote(
  p: Principal,
  input: { bill: number; amount: number; reason: string },
): Promise<{ id: number; creditNumber: string }> {
  requireStaff(p)
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a credit note carries its reason')
  if (!(input.amount > 0)) throw new OperationRefused('bad_amount', 'a credit note is above zero')
  return withPrincipal(p, async (tx) => {
    const bill = await issuedBill(tx, input.bill)
    const num = await tx.query(`select deedbox.allocate_number('credit_note') as n`)
    const creditNumber = num.rows[0].n as string
    const rendering = JSON.stringify({
      document: 'credit_note',
      credit_number: creditNumber,
      bill: input.bill,
      amount: input.amount,
      reason: input.reason,
    })
    const artefact = await tx.query(
      `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
       values ('credit_note_rendering', $1, $2, 'application/json', $3) returning id`,
      [rendering, createHash('sha256').update(rendering).digest('hex'), Buffer.byteLength(rendering)],
    )
    const r = await tx.query(
      `insert into deedbox.credit_note (credit_number, bill, amount, reason, issued_by, rendered_artefact)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [creditNumber, input.bill, input.amount, input.reason, p.id, String(artefact.rows[0].id)],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'credit_note',
      subject: r.rows[0].id as number,
      matter: bill.matter,
      reason: input.reason,
      detail: { credit_number: creditNumber, amount: input.amount, bill: input.bill },
    })
    return { id: r.rows[0].id as number, creditNumber }
  })
}

/** Apply credit to the note's bill. */
export async function applyCredit(
  p: Principal,
  input: { note: number; amount: number },
): Promise<void> {
  requireStaff(p)
  if (!(input.amount > 0)) throw new OperationRefused('bad_amount', 'each application is above zero')
  await withPrincipal(p, async (tx) => {
    await lockCreditNote(tx, input.note)
    const note = await tx.query(
      `select id, bill, amount from deedbox.credit_note where id = $1`,
      [input.note],
    )
    if (note.rowCount === 0) throw new OperationRefused('not_found', 'credit note not found')
    const bill = await issuedBill(tx, note.rows[0].bill as number)

    const applied = await tx.query(
      `select coalesce(-sum(signed_amount), 0) as a from deedbox.bill_journal_entry
        where entry_kind = 'credit_application' and source_type = 'credit_note' and source = $1
          and not exists (select 1 from deedbox.bill_journal_entry r where r.reverses = bill_journal_entry.id)`,
      [input.note],
    )
    const remaining = Number(note.rows[0].amount) - Number(applied.rows[0].a)
    if (input.amount > remaining + 0.005) {
      throw new OperationRefused(
        'beyond_note',
        `applying ${input.amount.toFixed(2)} exceeds the note's remaining ${remaining.toFixed(2)}`,
      )
    }
    const outstanding = await tx.query(`select deedbox.bill_outstanding($1) as o`, [bill.id])
    if (input.amount > Number(outstanding.rows[0].o) + 0.005) {
      throw new OperationRefused(
        'beyond_outstanding',
        `applying ${input.amount.toFixed(2)} exceeds the bill's outstanding ${Number(outstanding.rows[0].o).toFixed(2)}`,
      )
    }
    await tx.query(
      `insert into deedbox.bill_journal_entry
         (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
       values ($1, 'credit_application', $2, 'credit_note', $3, current_date, $4)`,
      [bill.id, -input.amount, input.note, p.id],
    )
    await stopReminderIfPaid(tx, bill.id)
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'credit_note',
      subject: input.note,
      matter: bill.matter,
      detail: { applied: input.amount, bill: bill.id },
    })
  })
}

/** Write off part or all of a bill's outstanding. */
export async function writeOffBill(
  p: Principal,
  input: { bill: number; amount: number; reason: string },
): Promise<{ id: number }> {
  requireStaff(p)
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a write-off carries its reason')
  if (!(input.amount > 0)) throw new OperationRefused('bad_amount', 'a write-off is above zero')
  return withPrincipal(p, async (tx) => {
    const bill = await issuedBill(tx, input.bill)
    const outstanding = await tx.query(`select deedbox.bill_outstanding($1) as o`, [input.bill])
    if (input.amount > Number(outstanding.rows[0].o) + 0.005) {
      throw new OperationRefused(
        'beyond_outstanding',
        `writing off ${input.amount.toFixed(2)} exceeds the outstanding ${Number(outstanding.rows[0].o).toFixed(2)}`,
      )
    }
    const r = await tx.query(
      `insert into deedbox.write_off (bill, amount, reason, authorised_by)
       values ($1, $2, $3, $4) returning id`,
      [input.bill, input.amount, input.reason, p.id],
    )
    await tx.query(
      `insert into deedbox.bill_journal_entry
         (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by, reason)
       values ($1, 'write_off', $2, 'write_off', $3, current_date, $4, $5)`,
      [input.bill, -input.amount, r.rows[0].id, p.id, input.reason],
    )
    await stopReminderIfPaid(tx, input.bill)
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'write_off',
      subject: r.rows[0].id as number,
      matter: bill.matter,
      reason: input.reason,
      detail: { bill: input.bill, amount: input.amount },
    })
    return { id: r.rows[0].id as number }
  })
}

/** Raise a dispute; the reminder stops. */
export async function raiseDispute(
  p: Principal,
  input: { bill: number; detail: string },
): Promise<{ id: number }> {
  requireStaff(p)
  if (!input.detail.trim()) throw new OperationRefused('detail_required', 'what is disputed?')
  return withPrincipal(p, async (tx) => {
    const bill = await issuedBill(tx, input.bill)
    const open = await tx.query(
      `select 1 from deedbox.bill_dispute where bill = $1 and resolved_at is null`,
      [input.bill],
    )
    if (open.rowCount! > 0) throw new OperationRefused('already_disputed', 'one open dispute per bill')
    const r = await tx.query(
      `insert into deedbox.bill_dispute (bill, raised_by, detail) values ($1, $2, $3) returning id`,
      [input.bill, p.id, input.detail],
    )
    // Reminder rule: running → stopped_disputed is the only dispute stop; a
    // bill already stopped (paid, arrangement, held) keeps its state
    await tx.query(
      `update deedbox.bill_reminder_state set status = 'stopped_disputed'
        where bill = $1 and status = 'running'`,
      [input.bill],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'bill_dispute',
      subject: r.rows[0].id as number,
      matter: bill.matter,
      detail: { bill: input.bill },
    })
    return { id: r.rows[0].id as number }
  })
}

/** Resolve; the resume rule applies automatically. */
export async function resolveDispute(
  p: Principal,
  input: { dispute: number; resolutionNote: string },
): Promise<void> {
  requireStaff(p)
  if (!input.resolutionNote.trim()) {
    throw new OperationRefused('note_required', 'a resolution carries its note')
  }
  await withPrincipal(p, async (tx) => {
    const d = await tx.query(
      `update deedbox.bill_dispute set resolved_at = now(), resolution_note = $2
        where id = $1 and resolved_at is null
        returning bill`,
      [input.dispute, input.resolutionNote],
    )
    if (d.rowCount === 0) throw new OperationRefused('not_open', 'no open dispute by that id')
    const billId = d.rows[0].bill as number
    const bill = await tx.query(`select matter from deedbox.bill where id = $1`, [billId])
    const outstanding = await tx.query(`select deedbox.bill_outstanding($1) as o`, [billId])
    if (Number(outstanding.rows[0].o) > 0) {
      await tx.query(
        `update deedbox.bill_reminder_state set status = 'running'
          where bill = $1 and status = 'stopped_disputed'`,
        [billId],
      )
    } else {
      // the machine has no stopped_disputed → stopped_paid hop; travel
      // through running (both hops legal) so the state lands on the truth
      const hop = await tx.query(
        `update deedbox.bill_reminder_state set status = 'running'
          where bill = $1 and status = 'stopped_disputed' returning id`,
        [billId],
      )
      if (hop.rowCount! > 0) {
        await tx.query(
          `update deedbox.bill_reminder_state set status = 'stopped_paid' where bill = $1`,
          [billId],
        )
      }
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'bill_dispute',
      subject: input.dispute,
      matter: bill.rows[0].matter as number,
      detail: { resolved: true },
    })
  })
}

/** Place a billing hold; the matter mirror follows by trigger. */
export async function placeBillingHold(
  p: Principal,
  input: { matter: number; reason: string },
): Promise<{ id: number }> {
  requireStaff(p)
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a hold carries its reason')
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(`select id from deedbox.matter where id = $1 for update`, [
      input.matter,
    ])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    const open = await tx.query(
      `select 1 from deedbox.billing_hold where matter = $1 and released_at is null`,
      [input.matter],
    )
    if (open.rowCount! > 0) throw new OperationRefused('already_held', 'one open hold per matter')
    const r = await tx.query(
      `insert into deedbox.billing_hold (matter, reason, placed_by) values ($1, $2, $3) returning id`,
      [input.matter, input.reason, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'billing_hold',
      subject: r.rows[0].id as number,
      matter: input.matter,
      reason: input.reason,
    })
    return { id: r.rows[0].id as number }
  })
}

/** Release; the row is history forever. */
export async function releaseBillingHold(p: Principal, input: { hold: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.billing_hold set released_by = $2, released_at = now()
        where id = $1 and released_at is null
        returning matter`,
      [input.hold, p.id],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_open', 'no open hold by that id')
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'billing_hold',
      subject: input.hold,
      matter: r.rows[0].matter as number,
      detail: { released: true },
    })
  })
}
