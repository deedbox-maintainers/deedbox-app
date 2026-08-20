// Client-money dormancy: detection (inert where the pack declares no
// period), contact attempts with evidence, and remittance to the pack-named
// authority (a money payment of purpose remittance walked through the
// normal ceremony; its EXECUTION transaction also writes the remittance
// register row — which survives matter closure by construction, keying on
// the ledger — and moves the case to remitted). Where the pack declares
// minimum contact attempts, execution refuses until they are met and
// evidenced. Resolution (the client found, or the balance properly paid
// out) closes a case without remitting.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused, runMoneyOperation, MoneyRefusal } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'
import { executePaymentCoreInTx, loadExecutableDoc } from './payments'

/** The detection job: inert without a pack dormancy period. */
export async function runDormancyDetection(
  p: Principal,
): Promise<{ opened: { case: number; ledger: number }[] }> {
  const opened: { case: number; ledger: number }[] = []
  const scope = await withPrincipal(
    p,
    async (tx) => {
      const decl = await tx.query(
        `select d.body from deedbox.pack_declaration d
           join deedbox.firm f on f.id = $1
           join deedbox.country_pack cp on cp.id = f.country_pack
           join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
          where d.rule_point = 'money.dormancy'`,
        [p.firm],
      )
      let months: number | null = null
      for (const row of decl.rows) {
        const b = row.body as { dormant_after_months?: number }
        if (b.dormant_after_months !== undefined) months = b.dormant_after_months
      }
      if (months === null) return null // inert: the pack declares no period
      const r = await tx.query(
        `select ml.id, deedbox.ledger_balance(ml.id) as balance
           from deedbox.matter_ledger ml
          where ml.ledger_kind = 'client_matter' and ml.status = 'open'
            and deedbox.ledger_balance(ml.id) > 0
            and not exists (select 1 from deedbox.dormant_case dc
                             where dc.matter_ledger = ml.id
                               and dc.state in ('open','contact_in_progress'))
            and not exists (
              select 1 from deedbox.ledger_line l
               join deedbox.money_transaction t on t.id = l.transaction
              where l.matter_ledger = ml.id
                and t.entered_at > now() - make_interval(months => $1::int))
          order by ml.id`,
        [months],
      )
      return r.rows as { id: number; balance: string }[]
    },
    { readOnly: true },
  )
  if (!scope) return { opened }
  for (const ledger of scope) {
    await withPrincipal(p, async (tx) => {
      const c = await tx.query(
        `insert into deedbox.dormant_case (matter_ledger, balance_at_detection)
         values ($1, $2) returning id`,
        [ledger.id, Number(ledger.balance)],
      )
      const matter = await tx.query(
        `select matter from deedbox.matter_ledger where id = $1`,
        [ledger.id],
      )
      await emitRegister(tx, p, {
        kind: 'record.created',
        subjectType: 'dormant_case',
        subject: c.rows[0].id as number,
        matter: matter.rows[0].matter as number,
        detail: { ledger: ledger.id, balance: Number(ledger.balance) },
      })
      opened.push({ case: c.rows[0].id as number, ledger: ledger.id })
    })
  }
  return { opened }
}

/** Record a contact attempt with its evidence. */
export async function recordContactAttempt(
  p: Principal,
  input: { case: number; channel: string; evidence: string },
): Promise<{ id: number }> {
  requireStaff(p)
  if (!input.evidence.trim()) {
    throw new OperationRefused('evidence_required', 'a contact attempt carries its evidence')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_dormancy')
    const c = await tx.query(
      `select dc.id, dc.state, ml.matter from deedbox.dormant_case dc
        join deedbox.matter_ledger ml on ml.id = dc.matter_ledger
       where dc.id = $1 for update of dc`,
      [input.case],
    )
    if (c.rowCount === 0) throw new OperationRefused('not_found', 'dormant case not found')
    if (c.rows[0].state !== 'open' && c.rows[0].state !== 'contact_in_progress') {
      throw new OperationRefused('terminal', 'a remitted or resolved case takes no attempts')
    }
    const r = await tx.query(
      `insert into deedbox.contact_attempt ("case", channel, evidence)
       values ($1, $2, $3) returning id`,
      [input.case, input.channel, input.evidence],
    )
    if (c.rows[0].state === 'open') {
      await tx.query(
        `update deedbox.dormant_case set state = 'contact_in_progress' where id = $1`,
        [input.case],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'dormant_case',
      subject: input.case,
      matter: c.rows[0].matter as number,
      detail: { attempt: r.rows[0].id, channel: input.channel },
    })
    return { id: r.rows[0].id as number }
  })
}

/** Resolve a case without remitting (found, or properly paid out). */
export async function resolveDormantCase(
  p: Principal,
  input: { case: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a resolution carries its reason')
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_dormancy')
    const r = await tx.query(
      `update deedbox.dormant_case set state = 'resolved', resolved_reason = $2
        where id = $1 and state in ('open','contact_in_progress')
        returning matter_ledger`,
      [input.case, input.reason],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_open', 'no live dormant case by that id')
    const matter = await tx.query(`select matter from deedbox.matter_ledger where id = $1`, [
      r.rows[0].matter_ledger,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'dormant_case',
      subject: input.case,
      matter: matter.rows[0].matter as number,
      reason: input.reason,
      detail: { resolved: true },
    })
  })
}

/**
 * Execute the remittance: the AUTHORISED remittance payment
 * (drafted through the ceremony with its dormant case attached) executes
 * under the posting protocol, and the SAME transaction writes the
 * remittance register row and moves the case to remitted. Pack-declared
 * minimum contact attempts gate the execution.
 */
export async function executeRemittance(
  p: Principal,
  input: { payment: number; authority: string; documentation: string },
): Promise<{ transaction: number; paymentNumber: string; register: number }> {
  requireStaff(p)
  if (!input.authority.trim() || !input.documentation.trim()) {
    throw new OperationRefused('documentation_required', 'a remittance names its authority and documentation')
  }
  const doc = await loadExecutableDoc(p, input.payment)
  if (doc.purpose !== 'remittance') {
    throw new OperationRefused('wrong_purpose', 'this execution path is for remittance payments')
  }
  if (doc.dormant_case === null) {
    throw new OperationRefused('case_required', 'a remittance payment names its dormant case')
  }
  const dormantCase = doc.dormant_case
  try {
    return await runMoneyOperation(
      p,
      { account: doc.account, matterLedger: doc.matter_ledger, operation: 'execute_remittance' },
      async (tx) => {
        await requireCapability(tx, p, 'money.manage_dormancy')
        const dc = await tx.query(
          `select id, state from deedbox.dormant_case where id = $1 for update`,
          [dormantCase],
        )
        if (dc.rowCount === 0 || (dc.rows[0].state !== 'contact_in_progress' && dc.rows[0].state !== 'open')) {
          throw new OperationRefused('not_open', 'the dormant case is not live')
        }
        // pack-declared minimum contact attempts gate the execution
        const decl = await tx.query(
          `select d.body from deedbox.pack_declaration d
             join deedbox.firm f on f.id = $1
             join deedbox.country_pack cp on cp.id = f.country_pack
             join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
            where d.rule_point = 'money.dormancy'`,
          [p.firm],
        )
        let minAttempts = 0
        for (const row of decl.rows) {
          const b = row.body as { minimum_contact_attempts?: number }
          if (b.minimum_contact_attempts !== undefined) minAttempts = b.minimum_contact_attempts
        }
        if (minAttempts > 0) {
          const attempts = await tx.query(
            `select count(*)::int as n from deedbox.contact_attempt where "case" = $1`,
            [dormantCase],
          )
          if ((attempts.rows[0].n as number) < minAttempts) {
            throw new OperationRefused(
              'attempts_missing',
              `the pack requires ${minAttempts} evidenced contact attempts; ${attempts.rows[0].n} recorded`,
            )
          }
        }
        const executed = await executePaymentCoreInTx(tx, p, doc)
        const reg = await tx.query(
          `insert into deedbox.remittance_register
             ("case", authority, amount, remitted_date, transaction, documentation)
           values ($1, $2, $3, current_date, $4, $5) returning id`,
          [dormantCase, input.authority, Number(doc.amount), executed.transaction, input.documentation],
        )
        await tx.query(`update deedbox.dormant_case set state = 'remitted' where id = $1`, [
          dormantCase,
        ])
        await emitRegister(tx, p, {
          kind: 'record.changed',
          subjectType: 'dormant_case',
          subject: dormantCase,
          matter: doc.matter,
          detail: {
            remitted: true,
            authority: input.authority,
            amount: Number(doc.amount),
            remittance_register: reg.rows[0].id,
          },
        })
        return { ...executed, register: reg.rows[0].id as number }
      },
    )
  } catch (e) {
    if (e instanceof MoneyRefusal) {
      await withPrincipal(p, async (tx) => {
        await tx.query(
          `update deedbox.money_payment set state = 'blocked' where id = $1 and state = 'authorised'`,
          [input.payment],
        )
      })
    }
    throw e
  }
}
