// Reminders. Sequences and steps are firm administration under
// `reminders.manage`; nothing constrains count, spacing or wording. The
// scheduler advances one bill per transaction, idempotent per (bill,
// step_no) through the contact row's existence, re-verifying the stop
// conditions before any send; every contact registers
// `reminder.contact_made` with the matter, so it lands on the timeline. The
// resume rule is uniform: no step skipped, none re-sent, next_step_at =
// max(now, last contact + the next step's spacing; else due date + first
// step's days).
//
// Implementation notes: setting a new default sequence demotes the prior
// default in the same registered transaction; a reminder's rendered message
// resolves the documented tokens ({{firm_name}}, {{bill_number}},
// {{amount_outstanding}}, {{due_date}}, {{matter_number}}, {{payment_link}},
// {{client_name}}) and is stored as an artefact; the payment link reuses the
// bill's active payment reference or issues one.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'
import { createHash, randomBytes } from 'node:crypto'

export interface ReminderStepInput {
  stepNo: number
  daysAfterPrevious: number
  channel: 'email' | 'text_message' | 'task'
  template: number
}

/** Create a sequence with its steps, whole. */
export async function createReminderSequence(
  p: Principal,
  input: { name: string; defaultForNewBills?: boolean; steps: ReminderStepInput[] },
): Promise<{ id: number }> {
  if (!input.name.trim()) throw new OperationRefused('name_required', 'a sequence carries a name')
  if (input.steps.length === 0) {
    throw new OperationRefused('steps_required', 'a sequence carries at least one step')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'reminders.manage')
    for (const s of input.steps) {
      if (s.daysAfterPrevious < 0 || !Number.isInteger(s.daysAfterPrevious)) {
        throw new OperationRefused('bad_spacing', 'step spacing is a whole number of days, zero or above')
      }
      const t = await tx.query(
        `select channel from deedbox.message_template where id = $1 and active`,
        [s.template],
      )
      if (t.rowCount === 0) {
        throw new OperationRefused('template_missing', `no active template ${s.template}`)
      }
      if (t.rows[0].channel !== s.channel) {
        throw new OperationRefused(
          'channel_mismatch',
          `step ${s.stepNo} is ${s.channel} but its template is ${t.rows[0].channel}`,
        )
      }
    }
    if (input.defaultForNewBills) {
      await tx.query(
        `update deedbox.reminder_sequence set default_for_new_bills = false
          where default_for_new_bills and active`,
      )
    }
    const seq = await tx.query(
      `insert into deedbox.reminder_sequence (name, default_for_new_bills)
       values ($1, $2) returning id`,
      [input.name, input.defaultForNewBills ?? false],
    )
    for (const s of input.steps) {
      await tx.query(
        `insert into deedbox.reminder_step (sequence, step_no, days_after_previous, channel, template)
         values ($1, $2::int, $3::int, $4, $5)`,
        [seq.rows[0].id, s.stepNo, s.daysAfterPrevious, s.channel, s.template],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'reminder_sequence',
      subject: seq.rows[0].id as number,
      detail: {
        name: input.name,
        steps: input.steps.length,
        default_for_new_bills: input.defaultForNewBills ?? false,
      },
    })
    return { id: seq.rows[0].id as number }
  })
}

/**
 * The uniform resume rule: current step unchanged; next_step_at =
 * max(now, last contact + next step's spacing), or due date + first step's
 * days when nothing has been sent. Returns false when the sequence is
 * already past its last step (the caller exhausts instead).
 */
export async function resumeReminderInTx(tx: Tx, billId: number): Promise<boolean> {
  const st = await tx.query(
    `select rs.id, rs.sequence, rs.current_step_no from deedbox.bill_reminder_state rs
      where rs.bill = $1`,
    [billId],
  )
  if (st.rowCount === 0) return false
  const seq = st.rows[0].sequence as number
  const currentStep = st.rows[0].current_step_no as number
  const next = await tx.query(
    `select step_no, days_after_previous from deedbox.reminder_step
      where sequence = $1 and step_no > $2::int order by step_no limit 1`,
    [seq, currentStep],
  )
  if (next.rowCount === 0) {
    // only running → exhausted is a legal hop: resume first, then exhaust
    await tx.query(
      `update deedbox.bill_reminder_state set status = 'running'
        where bill = $1 and status <> 'running'`,
      [billId],
    )
    await tx.query(
      `update deedbox.bill_reminder_state set status = 'exhausted', next_step_at = null
        where bill = $1`,
      [billId],
    )
    return false
  }
  await tx.query(
    `update deedbox.bill_reminder_state rs
        set status = 'running',
            next_step_at = greatest(
              now(),
              coalesce(
                (select max(c.sent_at) from deedbox.reminder_contact c where c.bill = $1)
                  + make_interval(days => $2::int),
                (select b.due_date from deedbox.bill b where b.id = $1)
                  + make_interval(days => (
                      select s.days_after_previous from deedbox.reminder_step s
                       where s.sequence = rs.sequence order by s.step_no limit 1))
              ))
      where rs.bill = $1`,
    [billId, next.rows[0].days_after_previous],
  )
  return true
}

/** Manual hold; reason required. */
export async function holdReminder(
  p: Principal,
  input: { bill: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a hold carries its reason')
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.bill_reminder_state
          set status = 'held_manual', held_by = $2, held_at = now(), hold_reason = $3
        where bill = $1 and status = 'running'
        returning id`,
      [input.bill, p.id, input.reason],
    )
    if (r.rowCount === 0) {
      throw new OperationRefused('not_running', 'only a running reminder holds')
    }
    const m = await tx.query(`select matter from deedbox.bill where id = $1`, [input.bill])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'bill_reminder_state',
      subject: r.rows[0].id as number,
      matter: m.rows[0].matter as number,
      reason: input.reason,
      detail: { before: 'running', after: 'held_manual' },
    })
  })
}

/** Release a manual hold; the resume rule applies. */
export async function releaseReminder(p: Principal, input: { bill: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const st = await tx.query(
      `select id, status from deedbox.bill_reminder_state where bill = $1 for update`,
      [input.bill],
    )
    if (st.rowCount === 0 || st.rows[0].status !== 'held_manual') {
      throw new OperationRefused('not_held', 'no manual hold on this bill')
    }
    await resumeReminderInTx(tx, input.bill)
    const m = await tx.query(`select matter from deedbox.bill where id = $1`, [input.bill])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'bill_reminder_state',
      subject: st.rows[0].id as number,
      matter: m.rows[0].matter as number,
      detail: { before: 'held_manual', after: 'running' },
    })
  })
}

/** Assign or change a bill's sequence; the count restarts. */
export async function assignReminderSequence(
  p: Principal,
  input: { bill: number; sequence: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const bill = await tx.query(
      `select id, matter, state, due_date from deedbox.bill where id = $1 for update`,
      [input.bill],
    )
    if (bill.rowCount === 0) throw new OperationRefused('not_found', 'bill not found')
    if (bill.rows[0].state !== 'issued') {
      throw new OperationRefused('not_issued', 'reminders run on issued bills')
    }
    const seq = await tx.query(
      `select id from deedbox.reminder_sequence where id = $1 and active`,
      [input.sequence],
    )
    if (seq.rowCount === 0) throw new OperationRefused('not_found', 'no active sequence by that id')
    const first = await tx.query(
      `select days_after_previous from deedbox.reminder_step
        where sequence = $1 order by step_no limit 1`,
      [input.sequence],
    )
    if (first.rowCount === 0) {
      throw new OperationRefused('steps_required', 'the sequence has no steps')
    }
    const existing = await tx.query(
      `update deedbox.bill_reminder_state
          set sequence = $2, current_step_no = 0, status = 'running',
              next_step_at = greatest(now(), (select due_date from deedbox.bill where id = $1)
                                              + make_interval(days => $3::int))
        where bill = $1
        returning id`,
      [input.bill, input.sequence, first.rows[0].days_after_previous],
    )
    let stateId: number
    if (existing.rowCount === 0) {
      const ins = await tx.query(
        `insert into deedbox.bill_reminder_state (bill, sequence, next_step_at)
         values ($1, $2, greatest(now(), (select due_date from deedbox.bill where id = $1)
                                          + make_interval(days => $3::int)))
         returning id`,
        [input.bill, input.sequence, first.rows[0].days_after_previous],
      )
      stateId = ins.rows[0].id as number
    } else {
      stateId = existing.rows[0].id as number
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'bill_reminder_state',
      subject: stateId,
      matter: bill.rows[0].matter as number,
      detail: { sequence_assigned: input.sequence, step_count_reset: true },
    })
  })
}

const TOKEN_KEYS = [
  'firm_name',
  'bill_number',
  'amount_outstanding',
  'due_date',
  'matter_number',
  'payment_link',
  'client_name',
] as const

async function resolveTokens(tx: Tx, billId: number): Promise<Record<string, string>> {
  const r = await tx.query(
    `select f.name as firm_name, b.bill_number, b.due_date::text as due_date,
            deedbox.bill_outstanding(b.id)::text as amount_outstanding,
            m.matter_number, m.id as matter_id, cp.display_name as client_name
       from deedbox.bill b
       join deedbox.matter m on m.id = b.matter
       join deedbox.party cp on cp.id = m.client_party
       cross join (select name from deedbox.firm order by id limit 1) f
      where b.id = $1`,
    [billId],
  )
  const row = r.rows[0]
  // the payment link rides the bill's active reference, issued on first need
  const existing = await tx.query(
    `select code from deedbox.payment_reference
      where target_kind = 'bill' and target = $1 and active limit 1`,
    [billId],
  )
  let code: string
  if (existing.rowCount! > 0) {
    code = existing.rows[0].code as string
  } else {
    code = randomBytes(24).toString('base64url')
    await tx.query(
      `insert into deedbox.payment_reference (code, target_kind, target, expected_amount)
       values ($1, 'bill', $2, deedbox.bill_outstanding($2))`,
      [code, billId],
    )
  }
  return {
    firm_name: row.firm_name as string,
    bill_number: row.bill_number as string,
    amount_outstanding: Number(row.amount_outstanding).toFixed(2),
    due_date: row.due_date as string,
    matter_number: row.matter_number as string,
    payment_link: `pay/${code}`,
    client_name: row.client_name as string,
  }
}

function renderTemplate(body: string, tokens: Record<string, string>): string {
  let out = body
  for (const k of TOKEN_KEYS) {
    out = out.split(`{{${k}}}`).join(tokens[k] ?? '')
  }
  return out
}

export interface SchedulerResult {
  advanced: { bill: number; stepNo: number; channel: string }[]
  stopped: { bill: number; to: string }[]
}

/**
 * The scheduler's body: one transaction per due bill. The runner
 * (platform-scheduled route) arrives with the jobs slice; tests and the
 * panel invoke this directly.
 */
export async function runReminderScheduler(p: Principal): Promise<SchedulerResult> {
  const result: SchedulerResult = { advanced: [], stopped: [] }
  // First, the parked-for-cover pass (0060): a reminder parked because the
  // firm already held the client's money re-arms the moment cover lapses
  // (the uniform resume rule — no step skipped, none re-sent), or closes
  // stopped_paid when the bill was paid meanwhile (the held money applied).
  const parked = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select rs.bill, b.matter from deedbox.bill_reminder_state rs
           join deedbox.bill b on b.id = rs.bill
          where rs.status = 'held_trust_cover'`,
      )
      return r.rows.map((x) => ({ bill: x.bill as number, matter: x.matter as number }))
    },
    { readOnly: true },
  )
  for (const pk of parked) {
    await withPrincipal(p, async (tx) => {
      const st = await tx.query(
        `select id, status from deedbox.bill_reminder_state where bill = $1 for update`,
        [pk.bill],
      )
      if (st.rowCount === 0 || st.rows[0].status !== 'held_trust_cover') return
      const outstanding = await tx.query(`select deedbox.bill_outstanding($1) as o`, [pk.bill])
      if (Math.round(Number(outstanding.rows[0].o) * 100) <= 0) {
        await tx.query(
          `update deedbox.bill_reminder_state set status = 'stopped_paid', next_step_at = null
            where id = $1`,
          [st.rows[0].id],
        )
        result.stopped.push({ bill: pk.bill, to: 'stopped_paid' })
        return
      }
      const uncovered = await tx.query(`select deedbox.matter_uncovered_arrears($1) as d`, [pk.matter])
      if (Math.round(Number(uncovered.rows[0].d) * 100) > 0) {
        await resumeReminderInTx(tx, pk.bill)
        result.advanced.push({ bill: pk.bill, stepNo: 0, channel: 'resumed_cover_lapsed' })
      }
    })
  }
  const due = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select bill from deedbox.bill_reminder_state
          where status = 'running' and next_step_at is not null and next_step_at <= now()
          order by next_step_at`,
      )
      return r.rows.map((x) => x.bill as number)
    },
    { readOnly: true },
  )
  for (const billId of due) {
    await withPrincipal(p, async (tx) => {
      const st = await tx.query(
        `select rs.id, rs.sequence, rs.current_step_no, rs.status, rs.next_step_at,
                b.matter, b.due_date
           from deedbox.bill_reminder_state rs join deedbox.bill b on b.id = rs.bill
          where rs.bill = $1 for update of rs`,
        [billId],
      )
      if (st.rowCount === 0) return
      const row = st.rows[0]
      if (row.status !== 'running' || row.next_step_at === null) return
      // re-verify the stop conditions inside the sending transaction
      const outstanding = await tx.query(`select deedbox.bill_outstanding($1) as o`, [billId])
      if (Math.round(Number(outstanding.rows[0].o) * 100) <= 0) {
        await tx.query(
          `update deedbox.bill_reminder_state set status = 'stopped_paid' where id = $1`,
          [row.id],
        )
        result.stopped.push({ bill: billId, to: 'stopped_paid' })
        return
      }
      // trust cover (0060): a firm never writes to a client for money it is
      // already holding free for that client's matter — the reminder parks
      // visibly and the parked pass above re-arms it when cover lapses
      const uncovered = await tx.query(`select deedbox.matter_uncovered_arrears($1) as d`, [row.matter])
      if (Math.round(Number(uncovered.rows[0].d) * 100) <= 0) {
        await tx.query(
          `update deedbox.bill_reminder_state set status = 'held_trust_cover' where id = $1`,
          [row.id],
        )
        result.stopped.push({ bill: billId, to: 'held_trust_cover' })
        return
      }
      const step = await tx.query(
        `select s.step_no, s.days_after_previous, s.channel, s.template,
                t.subject, t.body
           from deedbox.reminder_step s
           join deedbox.message_template t on t.id = s.template
          where s.sequence = $1 and s.step_no > $2::int
          order by s.step_no limit 1`,
        [row.sequence, row.current_step_no],
      )
      if (step.rowCount === 0) {
        await tx.query(
          `update deedbox.bill_reminder_state set status = 'exhausted', next_step_at = null
            where id = $1`,
          [row.id],
        )
        result.stopped.push({ bill: billId, to: 'exhausted' })
        return
      }
      const s = step.rows[0]
      // idempotency on retry: this step's contact may already exist
      const already = await tx.query(
        `select 1 from deedbox.reminder_contact where bill = $1 and step_no = $2::int`,
        [billId, s.step_no],
      )
      if (already.rowCount! > 0) {
        await advancePointer(tx, row.id as number, row.sequence as number, s.step_no as number)
        return
      }

      let outboundId: number | null = null
      let taskId: number | null = null
      if (s.channel === 'task') {
        const owner = await tx.query(
          `select responsible_lawyer from deedbox.matter where id = $1`,
          [row.matter],
        )
        const tokens = await resolveTokens(tx, billId)
        const t = await tx.query(
          `insert into deedbox.task (matter, title, owner, origin, due_date)
           values ($1, $2, $3, 'reminder_step', current_date) returning id`,
          [row.matter, renderTemplate(s.body as string, tokens), owner.rows[0].responsible_lawyer],
        )
        taskId = t.rows[0].id as number
      } else {
        const tokens = await resolveTokens(tx, billId)
        const rendered = JSON.stringify({
          document: 'reminder_message',
          channel: s.channel,
          subject: s.subject === null ? null : renderTemplate(s.subject as string, tokens),
          body: renderTemplate(s.body as string, tokens),
        })
        const artefact = await tx.query(
          `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
           values ('reminder_rendering', $1, $2, 'application/json', $3) returning id`,
          [rendered, createHash('sha256').update(rendered).digest('hex'), Buffer.byteLength(rendered)],
        )
        const contact = await tx.query(
          `select c.value from deedbox.contact_point c
             join deedbox.matter m on m.client_party = c.party
            where m.id = $1 and c.kind = $2 and c.deleted_at is null
            order by c.is_primary desc, c.id limit 1`,
          [row.matter, s.channel === 'email' ? 'email' : 'phone'],
        )
        if (contact.rowCount === 0) {
          // no address to send to: the step still advances (the contact row
          // records the attempt with no message), keeping the sequence honest
          // rather than retrying forever
        } else {
          const ob = await tx.query(
            `insert into deedbox.outbound_message
               (channel, recipient, rendered_artefact, purpose, related_type, related)
             values ($1, $2, $3, 'bill_reminder', 'bill', $4) returning id`,
            [s.channel, contact.rows[0].value, String(artefact.rows[0].id), billId],
          )
          outboundId = ob.rows[0].id as number
        }
      }
      await tx.query(
        `insert into deedbox.reminder_contact (bill, step_no, channel, outbound_message, task)
         values ($1, $2::int, $3, $4, $5)`,
        [billId, s.step_no, s.channel, outboundId, taskId],
      )
      await advancePointer(tx, row.id as number, row.sequence as number, s.step_no as number)
      await emitRegister(tx, p, {
        kind: 'reminder.contact_made',
        subjectType: 'bill',
        subject: billId,
        matter: row.matter as number,
        detail: { step_no: s.step_no, channel: s.channel },
      })
      result.advanced.push({ bill: billId, stepNo: s.step_no as number, channel: s.channel as string })
    })
  }
  return result
}

/** Advance the pointer past a completed step; exhaust after the last. */
async function advancePointer(
  tx: Tx,
  stateId: number,
  sequence: number,
  completedStep: number,
): Promise<void> {
  const next = await tx.query(
    `select days_after_previous from deedbox.reminder_step
      where sequence = $1 and step_no > $2::int order by step_no limit 1`,
    [sequence, completedStep],
  )
  if (next.rowCount === 0) {
    await tx.query(
      `update deedbox.bill_reminder_state
          set current_step_no = $2::int, status = 'exhausted', next_step_at = null
        where id = $1`,
      [stateId, completedStep],
    )
  } else {
    await tx.query(
      `update deedbox.bill_reminder_state
          set current_step_no = $2::int,
              next_step_at = now() + make_interval(days => $3::int)
        where id = $1`,
      [stateId, completedStep, next.rows[0].days_after_previous],
    )
  }
}
