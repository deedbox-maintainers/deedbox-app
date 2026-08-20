// Payment arrangements and the jobs that drive them. One live arrangement
// covers any bill, ever (schema-enforced); while an arrangement is active
// the covered bills' reminders stop, and a broken arrangement resumes them
// in the same transaction. Instalment coverage is CUMULATIVE: an instalment
// is satisfied while total collections against covered bills since the
// arrangement began meet the sum of instalment amounts through its position
// — an early over-payment carries forward. The rule runs inside every
// allocating transaction (the client-money and payment paths call
// applyInstalmentCoverageInTx) and never unwinds: paid is terminal.
//
// Implementation notes: the notification window is three days before the due
// date, firm timezone; coverage counts allocations by their entered_at
// against the arrangement's creation instant (effective dates can be
// back-dated; entry instants cannot); completion is checked from active only
// (the state machine has no broken → completed path); the per-instalment
// notice renders the active `instalment_notice` template where one exists,
// else a plain built-in wording.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, settingText } from '@/lib/ops/shared'
import { resumeReminderInTx } from './reminders'
import { createHash, randomBytes } from 'node:crypto'

function centsOf(x: number | string): number {
  return Math.round(Number(x) * 100)
}

/** Create an arrangement over named issued bills. */
export async function createArrangement(
  p: Principal,
  input: {
    clientParty: number
    matter?: number
    coversFutureBills?: boolean
    instalmentAmount: number
    frequency: 'weekly' | 'every_two_weeks' | 'monthly' | 'custom'
    customIntervalDays?: number
    instalmentCount: number
    firstDueDate: string
    storedMethodRef?: string
    bills: number[]
  },
): Promise<{ id: number; instalments: { sequenceNo: number; dueDate: string }[] }> {
  requireStaff(p)
  if (!(input.instalmentAmount > 0)) {
    throw new OperationRefused('bad_amount', 'instalments are above zero')
  }
  if (!Number.isInteger(input.instalmentCount) || input.instalmentCount <= 0) {
    throw new OperationRefused('bad_count', 'the instalment count is a whole number above zero')
  }
  if ((input.frequency === 'custom') !== (input.customIntervalDays !== undefined)) {
    throw new OperationRefused('bad_frequency', 'a custom frequency names its interval; others never do')
  }
  if (input.bills.length === 0 && !input.coversFutureBills) {
    throw new OperationRefused('nothing_covered', 'an arrangement covers named bills, future bills, or both')
  }
  return withPrincipal(p, async (tx) => {
    for (const billId of input.bills) {
      const b = await tx.query(
        `select id, state, deedbox.bill_outstanding(id) as o from deedbox.bill where id = $1 for update`,
        [billId],
      )
      if (b.rowCount === 0) throw new OperationRefused('not_found', `bill ${billId} not found`)
      if (b.rows[0].state !== 'issued') {
        throw new OperationRefused('not_issued', `bill ${billId} is not issued`)
      }
      if (centsOf(b.rows[0].o) <= 0) {
        throw new OperationRefused('nothing_outstanding', `bill ${billId} has nothing outstanding`)
      }
      const covered = await tx.query(
        `select 1 from deedbox.arrangement_bill ab
          join deedbox.payment_arrangement a on a.id = ab.arrangement
         where ab.bill = $1 and a.state in ('active','broken')`,
        [billId],
      )
      if (covered.rowCount! > 0) {
        throw new OperationRefused('already_covered', `another live arrangement already covers bill ${billId}`)
      }
    }

    const arr = await tx.query(
      `insert into deedbox.payment_arrangement
         (client_party, matter, covers_future_bills, instalment_amount, frequency,
          custom_interval_days, instalment_count, stored_method_ref)
       values ($1, $2, $3, $4, $5, $6, $7::int, $8) returning id`,
      [
        input.clientParty,
        input.matter ?? null,
        input.coversFutureBills ?? false,
        input.instalmentAmount,
        input.frequency,
        input.customIntervalDays ?? null,
        input.instalmentCount,
        input.storedMethodRef ?? null,
      ],
    )
    const arrangementId = arr.rows[0].id as number
    for (const billId of input.bills) {
      await tx.query(
        `insert into deedbox.arrangement_bill (arrangement, bill) values ($1, $2)`,
        [arrangementId, billId],
      )
    }
    const schedule = await scheduleInstalmentsInTx(
      tx,
      arrangementId,
      input.firstDueDate,
      input.frequency,
      input.customIntervalDays ?? 0,
      input.instalmentCount,
      input.instalmentAmount,
      1,
    )
    for (const billId of input.bills) {
      await tx.query(
        `update deedbox.bill_reminder_state set status = 'stopped_arrangement'
          where bill = $1 and status = 'running'`,
        [billId],
      )
    }
    const matters = await tx.query(
      `select distinct b.matter from deedbox.bill b where b.id = any($1)`,
      [input.bills],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'payment_arrangement',
      subject: arrangementId,
      matter: matters.rowCount === 1 ? (matters.rows[0].matter as number) : input.matter,
      detail: {
        bills: input.bills,
        covers_future_bills: input.coversFutureBills ?? false,
        instalments: input.instalmentCount,
        instalment_amount: input.instalmentAmount,
        first_due: input.firstDueDate,
      },
    })
    return { id: arrangementId, instalments: schedule }
  })
}

/** Generate the schedule rows from a first due date. */
async function scheduleInstalmentsInTx(
  tx: Tx,
  arrangementId: number,
  firstDueDate: string,
  frequency: string,
  customDays: number,
  count: number,
  amount: number,
  startSequence: number,
): Promise<{ sequenceNo: number; dueDate: string }[]> {
  const dates = await tx.query(
    frequency === 'monthly'
      ? `select (($1::date) + make_interval(months => g.i))::date::text as d
           from generate_series(0, $2::int - 1) as g(i)`
      : `select (($1::date) + make_interval(days => g.i * $3::int))::date::text as d
           from generate_series(0, $2::int - 1) as g(i)`,
    frequency === 'monthly'
      ? [firstDueDate, count]
      : [
          firstDueDate,
          count,
          frequency === 'weekly' ? 7 : frequency === 'every_two_weeks' ? 14 : customDays,
        ],
  )
  const out: { sequenceNo: number; dueDate: string }[] = []
  for (let i = 0; i < dates.rows.length; i++) {
    const seqNo = startSequence + i
    await tx.query(
      `insert into deedbox.instalment (arrangement, sequence_no, due_date, amount)
       values ($1, $2::int, $3::date, $4)`,
      [arrangementId, seqNo, dates.rows[i].d, amount],
    )
    out.push({ sequenceNo: seqNo, dueDate: dates.rows[i].d as string })
  }
  return out
}

/**
 * Reactivate a broken arrangement from a stated new first due date.
 * The remaining plan slots move onto the new date ladder: live rows
 * (scheduled/notified/collecting) reschedule in place; missed rows are
 * terminal evidence and each gets a fresh replacement slot appended, so the
 * plan keeps its full count. The coverage ladder excludes missed rows, so a
 * replaced slot's amount is counted exactly once.
 */
export async function reactivateArrangement(
  p: Principal,
  input: { arrangement: number; newFirstDueDate: string },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const a = await tx.query(
      `select id, state, frequency, custom_interval_days, instalment_amount
         from deedbox.payment_arrangement where id = $1 for update`,
      [input.arrangement],
    )
    if (a.rowCount === 0) throw new OperationRefused('not_found', 'arrangement not found')
    if (a.rows[0].state !== 'broken') {
      throw new OperationRefused('not_broken', 'only a broken arrangement reactivates')
    }
    const live = await tx.query(
      `select id, sequence_no, due_date::text as due, state from deedbox.instalment
        where arrangement = $1 and state in ('scheduled','notified','collecting')
        order by due_date, sequence_no`,
      [input.arrangement],
    )
    const missed = await tx.query(
      `select count(*)::int as n from deedbox.instalment
        where arrangement = $1 and state = 'missed'`,
      [input.arrangement],
    )
    const before = live.rows.map((r) => ({ sequence_no: r.sequence_no, due: r.due, state: r.state }))
    const slotCount = live.rowCount! + (missed.rows[0].n as number)
    if (slotCount === 0) {
      throw new OperationRefused('nothing_remaining', 'no unpaid instalments remain to reschedule')
    }

    await tx.query(
      `update deedbox.payment_arrangement set state = 'active', broken_at = null where id = $1`,
      [input.arrangement],
    )

    // the new date ladder for every remaining slot
    const freq = a.rows[0].frequency as string
    const stepDays =
      freq === 'weekly' ? 7 : freq === 'every_two_weeks' ? 14
        : (a.rows[0].custom_interval_days as number | null) ?? 0
    const ladder = await tx.query(
      freq === 'monthly'
        ? `select (($1::date) + make_interval(months => g.i))::date::text as d
             from generate_series(0, $2::int - 1) as g(i)`
        : `select (($1::date) + make_interval(days => g.i * $3::int))::date::text as d
             from generate_series(0, $2::int - 1) as g(i)`,
      freq === 'monthly'
        ? [input.newFirstDueDate, slotCount]
        : [input.newFirstDueDate, slotCount, stepDays],
    )
    const newSchedule: { sequenceNo: number; dueDate: string }[] = []
    // live rows first, in plan order, onto the earliest new dates
    for (let i = 0; i < live.rows.length; i++) {
      await tx.query(`update deedbox.instalment set due_date = $2::date where id = $1`, [
        live.rows[i].id,
        ladder.rows[i].d,
      ])
      newSchedule.push({ sequenceNo: live.rows[i].sequence_no as number, dueDate: ladder.rows[i].d as string })
    }
    // replacement slots for missed rows, appended after the highest sequence
    const maxSeq = await tx.query(
      `select coalesce(max(sequence_no), 0) as m from deedbox.instalment where arrangement = $1`,
      [input.arrangement],
    )
    for (let i = 0; i < (missed.rows[0].n as number); i++) {
      const seqNo = (maxSeq.rows[0].m as number) + 1 + i
      const d = ladder.rows[live.rows.length + i].d as string
      await tx.query(
        `insert into deedbox.instalment (arrangement, sequence_no, due_date, amount)
         values ($1, $2::int, $3::date, $4)`,
        [input.arrangement, seqNo, d, Number(a.rows[0].instalment_amount)],
      )
      newSchedule.push({ sequenceNo: seqNo, dueDate: d })
    }

    const bills = await tx.query(
      `select bill from deedbox.arrangement_bill where arrangement = $1`,
      [input.arrangement],
    )
    for (const b of bills.rows) {
      await tx.query(
        `update deedbox.bill_reminder_state set status = 'stopped_arrangement'
          where bill = $1 and status = 'running'`,
        [b.bill],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'payment_arrangement',
      subject: input.arrangement,
      detail: {
        before: { state: 'broken', remaining: before, missed_replaced: missed.rows[0].n },
        after: { state: 'active', schedule: newSchedule },
      },
    })
  })
}

/** Cancel; reminders resume in the same transaction. */
export async function cancelArrangement(
  p: Principal,
  input: { arrangement: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) {
    throw new OperationRefused('reason_required', 'a cancellation carries its reason')
  }
  await withPrincipal(p, async (tx) => {
    const a = await tx.query(
      `update deedbox.payment_arrangement set state = 'cancelled'
        where id = $1 and state in ('active','broken') returning id`,
      [input.arrangement],
    )
    if (a.rowCount === 0) {
      throw new OperationRefused('not_live', 'only an active or broken arrangement cancels')
    }
    const bills = await tx.query(
      `select bill from deedbox.arrangement_bill where arrangement = $1`,
      [input.arrangement],
    )
    for (const b of bills.rows) {
      const st = await tx.query(
        `select status from deedbox.bill_reminder_state where bill = $1`,
        [b.bill],
      )
      if (st.rowCount! > 0 && st.rows[0].status === 'stopped_arrangement') {
        const o = await tx.query(`select deedbox.bill_outstanding($1) as o`, [b.bill])
        if (centsOf(o.rows[0].o) > 0) {
          await resumeReminderInTx(tx, b.bill as number)
        } else {
          // no stopped_arrangement → stopped_paid hop exists; travel
          // through running, both hops legal
          await tx.query(
            `update deedbox.bill_reminder_state set status = 'running' where bill = $1`,
            [b.bill],
          )
          await tx.query(
            `update deedbox.bill_reminder_state set status = 'stopped_paid' where bill = $1`,
            [b.bill],
          )
        }
      }
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'payment_arrangement',
      subject: input.arrangement,
      reason: input.reason,
      detail: { before: { state: 'live' }, after: { state: 'cancelled' } },
    })
  })
}

/**
 * Cumulative coverage, applied inside every allocating transaction
 * (called by allocateInTx and channel settlement). Flips earliest
 * unsatisfied instalments to paid while collections cover them; completes
 * an active arrangement whose last instalment pays.
 */
export async function applyInstalmentCoverageInTx(
  tx: Tx,
  p: Principal,
  billId: number,
): Promise<void> {
  const arr = await tx.query(
    `select a.id, a.state, a.covers_future_bills, a.created_at
       from deedbox.payment_arrangement a
       join deedbox.arrangement_bill ab on ab.arrangement = a.id
      where ab.bill = $1 and a.state in ('active','broken')`,
    [billId],
  )
  if (arr.rowCount === 0) return
  const a = arr.rows[0]

  const collected = await tx.query(
    `select coalesce(-sum(j.signed_amount), 0) as c
       from deedbox.bill_journal_entry j
      where j.bill in (select ab.bill from deedbox.arrangement_bill ab where ab.arrangement = $1)
        and j.entered_at >= $2
        and (j.entry_kind = 'payment_allocation'
             or (j.entry_kind = 'reversal' and exists (
                   select 1 from deedbox.bill_journal_entry t
                    where t.id = j.reverses and t.entry_kind = 'payment_allocation')))`,
    [a.id, a.created_at],
  )
  const collectedCents = centsOf(collected.rows[0].c)

  const instalments = await tx.query(
    `select id, sequence_no, amount, state from deedbox.instalment
      where arrangement = $1 order by sequence_no`,
    [a.id],
  )
  let cumulative = 0
  for (const inst of instalments.rows) {
    cumulative += centsOf(inst.amount)
    if (
      (inst.state === 'scheduled' || inst.state === 'notified' || inst.state === 'collecting') &&
      collectedCents >= cumulative
    ) {
      await tx.query(`update deedbox.instalment set state = 'paid' where id = $1`, [inst.id])
      ;(inst as { state: string }).state = 'paid'
    }
  }

  // completion from active: every instalment paid and no covered scope open
  if (a.state === 'active') {
    const unpaidLeft = instalments.rows.some((i) => i.state !== 'paid' && i.state !== 'missed')
    const anyMissedUnpaid = instalments.rows.some((i) => i.state === 'missed')
    if (!unpaidLeft && !anyMissedUnpaid) {
      let scopeClear = true
      if (a.covers_future_bills) {
        const open = await tx.query(
          `select 1 from deedbox.arrangement_bill ab
            where ab.arrangement = $1 and deedbox.bill_outstanding(ab.bill) > 0 limit 1`,
          [a.id],
        )
        scopeClear = open.rowCount === 0
      }
      if (scopeClear) {
        await tx.query(
          `update deedbox.payment_arrangement set state = 'completed' where id = $1`,
          [a.id],
        )
        await emitRegister(tx, p, {
          kind: 'record.changed',
          subjectType: 'payment_arrangement',
          subject: a.id as number,
          detail: { before: { state: 'active' }, after: { state: 'completed' } },
        })
      }
    }
  }
}

/** Notify instalments entering the notice window (system job body). */
export async function runInstalmentNotifications(p: Principal): Promise<{ notified: number[] }> {
  const due = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select i.id from deedbox.instalment i
           join deedbox.payment_arrangement a on a.id = i.arrangement
          where i.state = 'scheduled' and a.state = 'active'
            and i.due_date <= ((now() at time zone (select timezone from deedbox.firm order by id limit 1))::date + 3)
          order by i.due_date, i.id`,
      )
      return r.rows.map((x) => x.id as number)
    },
    { readOnly: true },
  )
  const notified: number[] = []
  for (const instalmentId of due) {
    await withPrincipal(p, async (tx) => {
      const i = await tx.query(
        `select i.id, i.state, i.amount, i.due_date::text as due, i.notified_at,
                a.client_party
           from deedbox.instalment i
           join deedbox.payment_arrangement a on a.id = i.arrangement
          where i.id = $1 for update of i`,
        [instalmentId],
      )
      if (i.rowCount === 0) return
      const row = i.rows[0]
      if (row.state !== 'scheduled' || row.notified_at !== null) return // retry guard
      const tpl = await tx.query(
        `select body, subject from deedbox.message_template
          where purpose = 'instalment_notice' and channel = 'email' and active
          order by id desc limit 1`,
      )
      const body =
        tpl.rowCount! > 0
          ? (tpl.rows[0].body as string)
              .split('{{amount}}')
              .join(Number(row.amount).toFixed(2))
              .split('{{due_date}}')
              .join(row.due as string)
          : `An instalment of ${Number(row.amount).toFixed(2)} falls due on ${row.due}.`
      const rendered = JSON.stringify({ document: 'instalment_notice', body })
      const artefact = await tx.query(
        `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
         values ('instalment_notice_rendering', $1, $2, 'application/json', $3) returning id`,
        [rendered, createHash('sha256').update(rendered).digest('hex'), Buffer.byteLength(rendered)],
      )
      const contact = await tx.query(
        `select value from deedbox.contact_point
          where party = $1 and kind = 'email' and deleted_at is null
          order by is_primary desc, id limit 1`,
        [row.client_party],
      )
      if (contact.rowCount! > 0) {
        await tx.query(
          `insert into deedbox.outbound_message
             (channel, recipient, rendered_artefact, purpose, related_type, related)
           values ('email', $1, $2, 'instalment_notice', 'instalment', $3)`,
          [contact.rows[0].value, String(artefact.rows[0].id), instalmentId],
        )
      }
      await tx.query(
        `update deedbox.instalment set state = 'notified', notified_at = now() where id = $1`,
        [instalmentId],
      )
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'instalment',
        subject: instalmentId,
        detail: { notified: true, due_date: row.due },
      })
      notified.push(instalmentId)
    })
  }
  return { notified }
}

/** Start collection for notified instalments due today with a stored method. */
export async function runInstalmentCollections(p: Principal): Promise<{ collecting: number[] }> {
  const due = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select i.id from deedbox.instalment i
           join deedbox.payment_arrangement a on a.id = i.arrangement
          where i.state = 'notified' and a.state = 'active' and a.stored_method_ref is not null
            and i.due_date <= (now() at time zone (select timezone from deedbox.firm order by id limit 1))::date
          order by i.due_date, i.id`,
      )
      return r.rows.map((x) => x.id as number)
    },
    { readOnly: true },
  )
  const collecting: number[] = []
  for (const instalmentId of due) {
    await withPrincipal(p, async (tx) => {
      const i = await tx.query(
        `select i.id, i.state, i.amount, i.channel_payment, a.stored_method_ref
           from deedbox.instalment i
           join deedbox.payment_arrangement a on a.id = i.arrangement
          where i.id = $1 for update of i`,
        [instalmentId],
      )
      if (i.rowCount === 0) return
      const row = i.rows[0]
      if (row.state !== 'notified' || row.channel_payment !== null) return
      const code = randomBytes(24).toString('base64url')
      const ref = await tx.query(
        `insert into deedbox.payment_reference (code, target_kind, target, expected_amount)
         values ($1, 'instalment', $2, $3) returning id`,
        [code, instalmentId, Number(row.amount)],
      )
      const cp = await tx.query(
        `insert into deedbox.channel_payment
           (payment_reference, channel, method, amount, state_history, channel_event_ref)
         values ($1, 'stored_method', 'stored_method', $2, $3, $4) returning id`,
        [
          ref.rows[0].id,
          Number(row.amount),
          JSON.stringify([{ event: 'collection_started', instalment: instalmentId }]),
          `auto-collect-${instalmentId}`,
        ],
      )
      await tx.query(
        `update deedbox.instalment set state = 'collecting', channel_payment = $2 where id = $1`,
        [instalmentId, cp.rows[0].id],
      )
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'instalment',
        subject: instalmentId,
        detail: { collecting: true, channel_payment: cp.rows[0].id },
      })
      collecting.push(instalmentId)
    })
  }
  return { collecting }
}

/** Miss detection: grace passed in firm time without satisfaction. */
export async function runMissedInstalmentDetection(
  p: Principal,
): Promise<{ missed: number[]; broken: number[] }> {
  const candidates = await withPrincipal(
    p,
    async (tx) => {
      const grace = Number((await settingText(tx, 'arrangement.missed_grace_days')) ?? '0')
      const r = await tx.query(
        `select i.id from deedbox.instalment i
           join deedbox.payment_arrangement a on a.id = i.arrangement
          where i.state in ('scheduled','notified','collecting')
            and a.state in ('active','broken')
            and i.due_date + make_interval(days => $1::int)
                < (now() at time zone (select timezone from deedbox.firm order by id limit 1))::date
          order by i.due_date, i.id`,
        [grace],
      )
      return r.rows.map((x) => x.id as number)
    },
    { readOnly: true },
  )
  const result = { missed: [] as number[], broken: [] as number[] }
  for (const instalmentId of candidates) {
    await withPrincipal(p, async (tx) => {
      const i = await tx.query(
        `select i.id, i.state, i.arrangement, a.state as arrangement_state
           from deedbox.instalment i
           join deedbox.payment_arrangement a on a.id = i.arrangement
          where i.id = $1 for update of i`,
        [instalmentId],
      )
      if (i.rowCount === 0) return
      const row = i.rows[0]
      if (row.state !== 'scheduled' && row.state !== 'notified' && row.state !== 'collecting') return
      // apply cumulative coverage first: a covered instalment pays, not misses
      const anyBill = await tx.query(
        `select ab.bill from deedbox.arrangement_bill ab where ab.arrangement = $1 limit 1`,
        [row.arrangement],
      )
      if (anyBill.rowCount! > 0) {
        await applyInstalmentCoverageInTx(tx, p, anyBill.rows[0].bill as number)
      }
      const recheck = await tx.query(`select state from deedbox.instalment where id = $1`, [
        instalmentId,
      ])
      if (recheck.rows[0].state === 'paid') return

      await tx.query(`update deedbox.instalment set state = 'missed' where id = $1`, [instalmentId])
      result.missed.push(instalmentId)
      if (row.arrangement_state === 'active') {
        await tx.query(
          `update deedbox.payment_arrangement set state = 'broken' where id = $1`,
          [row.arrangement],
        )
        result.broken.push(row.arrangement as number)
        const bills = await tx.query(
          `select bill from deedbox.arrangement_bill where arrangement = $1`,
          [row.arrangement],
        )
        for (const b of bills.rows) {
          const st = await tx.query(
            `select status from deedbox.bill_reminder_state where bill = $1`,
            [b.bill],
          )
          if (st.rowCount! > 0 && st.rows[0].status === 'stopped_arrangement') {
            await resumeReminderInTx(tx, b.bill as number)
          }
        }
        await emitRegister(tx, p, {
          kind: 'record.changed',
          subjectType: 'payment_arrangement',
          subject: row.arrangement as number,
          detail: { before: { state: 'active' }, after: { state: 'broken' }, missed_instalment: instalmentId },
        })
      } else {
        await emitRegister(tx, p, {
          kind: 'record.changed',
          subjectType: 'instalment',
          subject: instalmentId,
          detail: { before: { state: row.state }, after: { state: 'missed' } },
        })
      }
    })
  }
  return result
}
