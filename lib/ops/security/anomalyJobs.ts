// Anomaly evaluation + the direct-raise interface, and the chain
// verifier — the two jobs unblocked by schema change 0027 (cursor writes
// forward-only; the chain_break rule; the checkpoint-walking verifier).
//
// Evaluation (per cursor-bearing rule, ONE transaction per rule): read the
// firm's register entries past the rule's cursor, evaluate the threshold
// doc, and on trigger insert the alert + `anomaly.raised` + queue an email
// to every active administrator — then advance the cursor in the SAME
// transaction, so evaluation is exactly-once per entry. The cursor is
// per-rule (the schema's single-firm design; this job filters by firm and
// advances past what it read).
//
// Notes: private_layer_violation and chain_break carry no cursor — they
// are direct-raise rules (the raiseAnomalyInTx interface, used by the
// configuration domain and the verifier). The verifier queues the same
// administrator notification as evaluation triggers do — a detected break
// is the gravest alert of all, and notification uniformity was chosen
// deliberately.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { queueOutboundMessageInTx } from '@/lib/ops/outbound/messages'

interface RuleRow {
  id: number
  key: string
  threshold: Record<string, unknown>
}

/**
 * The direct-raise interface: alert + `anomaly.raised` in the CALLER's
 * transaction, plus the administrator notification. Named system operations
 * (private-layer containment, the chain verifier, restore failures) call
 * this; evaluation triggers ride it too.
 */
export async function raiseAnomalyInTx(
  tx: Tx,
  p: Principal,
  input: { ruleKey: string; entries: number[]; summary: string },
): Promise<{ alert: number }> {
  const rule = await tx.query(
    `select id from deedbox.anomaly_rule where key = $1 and active`,
    [input.ruleKey],
  )
  if (rule.rowCount === 0) {
    throw new OperationRefused('rule_unknown', `no active anomaly rule named ${input.ruleKey}`)
  }
  const alert = await tx.query(
    `insert into deedbox.anomaly_alert (rule, triggering_register_entries, summary)
     values ($1, $2, $3) returning id`,
    [rule.rows[0].id, JSON.stringify(input.entries), input.summary],
  )
  const alertId = alert.rows[0].id as number
  await emitRegister(tx, p, {
    kind: 'anomaly.raised',
    subjectType: 'anomaly_alert',
    subject: alertId,
    detail: { rule: input.ruleKey, entries: input.entries, summary: input.summary },
  })
  const admins = await tx.query(
    `select s.email from deedbox.staff_member s
       join deedbox.role r on r.id = s.role
      where s.active and r.system_key = 'administrator' and s.email is not null`,
  )
  for (const a of admins.rows) {
    await queueOutboundMessageInTx(tx, p, {
      channel: 'email',
      recipient: a.email as string,
      purpose: 'anomaly_alert',
      content: `Security alert (${input.ruleKey}): ${input.summary}`,
      relatedType: 'anomaly_alert',
      related: alertId,
    })
  }
  return { alert: alertId }
}

// ---------------------------------------------------------------------------
// The evaluation job.
// ---------------------------------------------------------------------------

interface Trigger {
  entries: number[]
  summary: string
}

/** The three cursor-bearing rules' evaluators, over the batch read. */
function evaluate(
  rule: RuleRow,
  rows: { id: number; seq: number; event_kind: string; subject: number; detail: Record<string, unknown> | null }[],
  adminRoleId: number,
): Trigger[] {
  const t = rule.threshold
  if (rule.key === 'repeated_sign_in_failure') {
    // group the batch's failures by who was aimed at (staff id, or the
    // attempted login for unknown names); the window is evaluated over the
    // batch — the job runs every few minutes, far inside the window
    const groups = new Map<string, number[]>()
    for (const r of rows) {
      if (r.event_kind !== 'signin.failed') continue
      const d = r.detail ?? {}
      const who =
        r.subject !== 0 ? `staff:${r.subject}` : `login:${String(d.attempted_login ?? 'unknown')}`
      if (!groups.has(who)) groups.set(who, [])
      groups.get(who)!.push(r.id)
    }
    const need = Number(t.failures ?? 5)
    const out: Trigger[] = []
    for (const [who, ids] of groups) {
      if (ids.length >= need) {
        out.push({
          entries: ids,
          summary: `${ids.length} failed sign-ins for ${who} within one evaluation window`,
        })
      }
    }
    return out
  }
  if (rule.key === 'large_export') {
    const rowsCap = Number(t.rows ?? 10000)
    const anyRestricted = Boolean(t.any_restricted_matter ?? true)
    const out: Trigger[] = []
    for (const r of rows) {
      if (r.event_kind !== 'export.performed') continue
      // the register guard forces before/after on this kind — the facts
      // live under `after` (the real export writers' shape)
      const d = r.detail ?? {}
      const a = (d.after ?? d) as Record<string, unknown>
      const n = Number(a.rows ?? 0)
      const restricted = Number(a.restricted_matters ?? 0)
      if (n > rowsCap || (anyRestricted && restricted > 0)) {
        out.push({
          entries: [r.id],
          summary:
            restricted > 0
              ? `an export touched ${restricted} restricted matter(s) (${n} rows)`
              : `an export of ${n} rows exceeded the ${rowsCap}-row threshold`,
        })
      }
    }
    return out
  }
  if (rule.key === 'permission_escalation') {
    const out: Trigger[] = []
    for (const r of rows) {
      if (r.event_kind !== 'permission.changed') continue
      const d = r.detail ?? {}
      const after = (d.after ?? {}) as Record<string, unknown>
      if (d.changed_capability === 'security.administer') {
        out.push({ entries: [r.id], summary: 'security.administer was granted to a role' })
      } else if (d.money_authorisation_confirmed === true) {
        out.push({
          entries: [r.id],
          summary: `a money-authorisation capability (${String(d.changed_capability)}) was granted`,
        })
      } else if (Number(after.role ?? 0) === adminRoleId) {
        out.push({ entries: [r.id], summary: 'a person was moved onto the administrator role' })
      }
    }
    return out
  }
  return []
}

const CURSOR_RULES = ['repeated_sign_in_failure', 'large_export', 'permission_escalation']

/** One transaction per rule: evaluate, raise, advance. */
export async function runAnomalyEvaluation(
  p: Principal,
): Promise<{ evaluated: number; raised: number }> {
  let evaluated = 0
  let raised = 0
  for (const key of CURSOR_RULES) {
    const n = await withPrincipal(p, async (tx) => {
      const rule = await tx.query(
        `select id, key, threshold from deedbox.anomaly_rule where key = $1 and active`,
        [key],
      )
      if (rule.rowCount === 0) return 0
      const r = rule.rows[0] as unknown as RuleRow
      const cursor = await tx.query(
        `select last_seq from deedbox.anomaly_cursor where rule = $1`,
        [r.id],
      )
      const from = cursor.rowCount! > 0 ? (cursor.rows[0].last_seq as number) : 0
      const batch = await tx.query(
        `select id, seq, event_kind, subject, detail from deedbox.register_entry
          where firm = $1 and seq > $2
            and event_kind in ('signin.failed','export.performed','permission.changed')
          order by seq`,
        [p.firm, from],
      )
      if (batch.rowCount === 0) return 0
      const adminRole = await tx.query(
        `select id from deedbox.role where system_key = 'administrator'`,
      )
      const triggers = evaluate(
        r,
        batch.rows as never,
        adminRole.rowCount! > 0 ? (adminRole.rows[0].id as number) : -1,
      )
      for (const trig of triggers) {
        await raiseAnomalyInTx(tx, p, { ruleKey: r.key, entries: trig.entries, summary: trig.summary })
      }
      // exactly-once: the cursor advances past everything read, in this txn
      const maxSeq = batch.rows[batch.rows.length - 1].seq as number
      await tx.query(
        `insert into deedbox.anomaly_cursor (rule, last_seq) values ($1, $2)
         on conflict (rule) do update set last_seq = $2`,
        [r.id, maxSeq],
      )
      return triggers.length
    })
    evaluated += 1
    raised += n
  }
  return { evaluated, raised }
}

// ---------------------------------------------------------------------------
// The chain verifier.
// ---------------------------------------------------------------------------

/**
 * Note: the SCHEDULED run walks the FULL chain (from genesis).
 * An incremental walk from the last checkpoint can never see tampering
 * BEHIND that checkpoint — a changed historic detail breaks only its own
 * entry's hash, never the links after it — and the chain-integrity
 * invariant test demands exactly that detection. The checkpoint stays as the progress
 * record; {full:false} offers the incremental walk for on-demand use.
 */
export async function runChainVerification(
  p: Principal,
  input: { full?: boolean } = {},
): Promise<{ from: number; to: number; breaks: number; firstBadSeq: number | null }> {
  const full = input.full ?? true
  return withPrincipal(p, async (tx) => {
    const cp = await tx.query(
      `select max((detail ->> 'checkpoint_seq')::bigint) as c from deedbox.register_entry
        where firm = $1 and event_kind = 'chain.verified'`,
      [p.firm],
    )
    const from = full ? 0 : Number(cp.rows[0].c ?? 0)
    const v = await tx.query(
      `select breaks, first_bad_seq, last_seq from deedbox.register_verify_chain_detail($1, $2)`,
      [p.firm, from],
    )
    const breaks = Number(v.rows[0].breaks)
    const firstBadSeq = v.rows[0].first_bad_seq === null ? null : Number(v.rows[0].first_bad_seq)
    const lastSeq = Number(v.rows[0].last_seq)
    if (breaks === 0) {
      await emitRegister(tx, p, {
        kind: 'chain.verified',
        subjectType: 'register_chain',
        subject: p.firm,
        detail: { checkpoint_seq: lastSeq, walked_from: from },
      })
    } else {
      // a break never blocks new appends — the chain continues from the
      // head; the break is evidence of historic tampering
      await emitRegister(tx, p, {
        kind: 'chain.break_detected',
        subjectType: 'register_chain',
        subject: p.firm,
        detail: { first_bad_seq: firstBadSeq, breaks, walked_from: from },
      })
      await raiseAnomalyInTx(tx, p, {
        ruleKey: 'chain_break',
        entries: [],
        summary: `the register chain failed verification: ${breaks} break(s), first at seq ${firstBadSeq}`,
      })
    }
    return { from, to: lastSeq, breaks, firstBadSeq }
  })
}
