// Statutory set-aside over the 0014 schema (set_aside_requirement /
// set_aside_calculation, guarded to exactly one mutation: linking the
// movement). The formula is PACK CONTENT at the closed rule point
// money.set_aside (expression_formula, the shared tree encoding); no
// shipped pack declares it, so this machinery is dormant until a pack does
// — a deliberately neutral position.
//
// Shape of a movement: PAIRED set_aside_move transactions in ONE
// database transaction — one on the statutory account (cash +X and its
// holding ledger +X) and one on the pooled account (cash −X and its contra
// ledger −X), signs flipped for a release; each transaction is one cash
// line plus one equal ledger line; the kind demands an authorisation row
// (subject_type set_aside_move). Serialisation: the posting protocol takes
// both ledger locks and the contra locks itself.
//
// Notes:
// - The requirement binds the STATUTORY account and pins the pack version
//   ACTIVE at establishment (the 0014 column's own words) — re-establish to
//   move formula versions.
// - The recalculation job only writes evidence (a calculation row per due
//   requirement). Movements are always a HUMAN act: a money.record_payment
//   holder confirms one calculation, the authorisation row records them,
//   and the paired postings land linked to the calculation. One confirmer
//   suffices — one holder with authorisation, not two.
// - - account.* measures bind against the requirement's own statutory
//   account; firm.held_total measures CLIENT money (pooled and
//   separate-per-matter accounts), never the set-aside reserve itself.
// - - firm.held_total is INSTALLATION-global by design — the installation
//   IS the firm (matters and accounts carry no firm column; the measure
//   catalogue names the measure plain). On the multi-firm test scratch it
//   therefore sums every suite's client money — the suite asserts
//   baseline-relative, never absolute.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, runMoneyOperation, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'
import { ISO_DATE_LOCALE } from '@/lib/format'
import {
  evaluateExpression,
  moneyCents,
  dateValue,
  integer,
  NEUTRAL_CALENDAR,
  type Value,
  type EvalContext,
} from '@/lib/ops/config/expression'

/** The measures the money.set_aside rule point binds. */
const SET_ASIDE_MEASURES = new Set([
  'today',
  'firm.held_total',
  'account.held_sum',
  'account.held_max',
  'account.cash_book_balance',
  'account.ledger_total',
])

function isoToday(timezone: string): string {
  return new Intl.DateTimeFormat(ISO_DATE_LOCALE, { timeZone: timezone }).format(new Date())
}

function argDate(args: Value[], i: number, what: string): string {
  const a = args[i]
  if (!a || a.t !== 'date') {
    throw new OperationRefused('integrity_refusal', `${what} needs a date argument`)
  }
  return a.v
}

/**
 * The measure resolver, over the requirement's statutory account. Every
 * call is recorded into `inputs` — the calculation row's evidence.
 */
function makeResolver(
  tx: Tx,
  statutoryAccount: number,
  timezone: string,
  inputs: { measure: string; args: unknown[]; result: unknown }[],
) {
  return async (name: string, args: Value[]): Promise<Value | null> => {
    let result: Value | null = null
    const shownArgs: unknown[] = args.map((a) => ('v' in a ? String(a.v) : null))
    switch (name) {
      case 'today':
        result = dateValue(isoToday(timezone))
        break
      case 'firm.held_total': {
        const date = argDate(args, 0, 'firm.held_total')
        const r = await tx.query(
          `select coalesce(sum(l.signed_amount), 0)::numeric as held
             from deedbox.ledger_line l
             join deedbox.matter_ledger ml on ml.id = l.matter_ledger
             join deedbox.client_account ca on ca.id = ml.account
             join deedbox.money_transaction t on t.id = l.transaction
            where l.side = 'matter_ledger'
              and ml.ledger_kind = 'client_matter'
              and ca.account_kind in ('pooled','separate_per_matter')
              and t.effective_date <= $1`,
          [date],
        )
        result = moneyFromNumeric(r.rows[0].held as string)
        break
      }
      case 'account.held_sum': {
        const date = argDate(args, 0, 'account.held_sum')
        const r = await tx.query(
          `select coalesce(sum(l.signed_amount), 0)::numeric as held
             from deedbox.ledger_line l
             join deedbox.matter_ledger ml on ml.id = l.matter_ledger
             join deedbox.money_transaction t on t.id = l.transaction
            where l.side = 'matter_ledger' and ml.account = $1
              and t.effective_date <= $2`,
          [statutoryAccount, date],
        )
        result = moneyFromNumeric(r.rows[0].held as string)
        break
      }
      case 'account.held_max': {
        const from = argDate(args, 0, 'account.held_max')
        const to = argDate(args, 1, 'account.held_max')
        const r = await tx.query(
          `with daily as (
             select t.effective_date as d, sum(l.signed_amount) as delta
               from deedbox.ledger_line l
               join deedbox.matter_ledger ml on ml.id = l.matter_ledger
               join deedbox.money_transaction t on t.id = l.transaction
              where l.side = 'matter_ledger' and ml.account = $1
                and t.effective_date <= $3
              group by t.effective_date
           ), running as (
             select d, sum(delta) over (order by d) as bal from daily
           )
           select coalesce(max(bal) filter (where d between $2 and $3),
                           (select bal from running where d < $2 order by d desc limit 1),
                           0)::numeric as peak`,
          [statutoryAccount, from, to],
        )
        result = moneyFromNumeric(r.rows[0].peak as string)
        break
      }
      case 'account.cash_book_balance': {
        const r = await tx.query(
          `select coalesce(sum(l.signed_amount), 0)::numeric as cash
             from deedbox.ledger_line l
            where l.side = 'cash_book' and l.account = $1`,
          [statutoryAccount],
        )
        result = moneyFromNumeric(r.rows[0].cash as string)
        break
      }
      case 'account.ledger_total': {
        const r = await tx.query(
          `select coalesce(sum(l.signed_amount), 0)::numeric as led
             from deedbox.ledger_line l
             join deedbox.matter_ledger ml on ml.id = l.matter_ledger
            where l.side = 'matter_ledger' and ml.account = $1`,
          [statutoryAccount],
        )
        result = moneyFromNumeric(r.rows[0].led as string)
        break
      }
      default:
        return null
    }
    inputs.push({ measure: name, args: shownArgs, result: result && 'v' in result ? String(result.v && typeof result.v === 'object' ? `${(result.v as { p: bigint }).p}/${(result.v as { q: bigint }).q}` : result.v) : null })
    return result
  }
}

/** numeric(14,2) text → an exact, already-rounded money value. */
function moneyFromNumeric(s: string): Value {
  const cents = Math.round(Number(s) * 100)
  return { t: 'money', v: { p: BigInt(cents), q: 100n }, rounded: true } as Value
}

async function setAsideDeclaration(
  tx: Tx,
  packVersion: number,
): Promise<{ body: unknown } | null> {
  const r = await tx.query(
    `select body from deedbox.pack_declaration
      where pack_version = $1 and rule_point = 'money.set_aside' and kind = 'expression_formula'`,
    [packVersion],
  )
  return r.rowCount === 0 ? null : { body: r.rows[0].body }
}

async function firmMeta(tx: Tx, firm: number): Promise<{ timezone: string; activeVersion: number | null }> {
  const r = await tx.query(
    `select f.timezone, cp.active_version
       from deedbox.firm f join deedbox.country_pack cp on cp.id = f.country_pack
      where f.id = $1`,
    [firm],
  )
  return { timezone: r.rows[0].timezone as string, activeVersion: r.rows[0].active_version as number | null }
}

// ---------------------------------------------------------------------------
// Establish a requirement.
// ---------------------------------------------------------------------------

export async function establishSetAsideRequirement(
  p: Principal,
  input: { account: number; schedule: { frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' } },
): Promise<{ requirement: number }> {
  if (!['daily', 'weekly', 'monthly', 'quarterly'].includes(input.schedule?.frequency)) {
    throw new OperationRefused('schedule_shape', 'the schedule names its frequency')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_accounts')
    const acct = await tx.query(
      `select account_kind, active from deedbox.client_account where id = $1`,
      [input.account],
    )
    if (acct.rowCount === 0) throw new OperationRefused('not_found', 'no account by that id')
    if (acct.rows[0].account_kind !== 'statutory_set_aside' || !acct.rows[0].active) {
      throw new OperationRefused(
        'wrong_account_kind',
        'a set-aside requirement binds an active statutory set-aside account',
      )
    }
    const meta = await firmMeta(tx, p.firm)
    if (meta.activeVersion === null) {
      throw new OperationRefused('no_active_pack', 'the firm has no active pack version')
    }
    const decl = await setAsideDeclaration(tx, meta.activeVersion)
    if (decl === null) {
      throw new OperationRefused(
        'no_set_aside_rule',
        'the active pack declares no money.set_aside formula — nothing to establish',
      )
    }
    // the holding ledger exists from establishment (one per account, guarded)
    const holding = await tx.query(
      `select id from deedbox.matter_ledger where account = $1 and ledger_kind = 'set_aside_holding'`,
      [input.account],
    )
    if (holding.rowCount === 0) {
      await tx.query(
        `insert into deedbox.matter_ledger (account, ledger_kind) values ($1, 'set_aside_holding')`,
        [input.account],
      )
    }
    const row = await tx.query(
      `insert into deedbox.set_aside_requirement (account, formula_pack_version, recalculation_schedule)
       values ($1, $2, $3) returning id`,
      [input.account, meta.activeVersion, JSON.stringify(input.schedule)],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'set_aside_requirement',
      subject: row.rows[0].id as number,
      detail: { account: input.account, pack_version: meta.activeVersion, schedule: input.schedule },
    })
    return { requirement: row.rows[0].id as number }
  })
}

// ---------------------------------------------------------------------------
// The scheduled recalculation — the job half. Evidence only — no money
// moves here.
// ---------------------------------------------------------------------------

const FREQUENCY_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 28, quarterly: 84 }

export async function runSetAsideRecalculation(
  p: Principal,
): Promise<{ evaluated: number; movementsNeeded: number; skipped: number }> {
  return withPrincipal(p, async (tx) => {
    const reqs = await tx.query(
      `select r.id, r.account, r.formula_pack_version, r.recalculation_schedule,
              (select max(c.calculated_at) from deedbox.set_aside_calculation c
                where c.requirement = r.id) as last_calc
         from deedbox.set_aside_requirement r
         join deedbox.client_account ca on ca.id = r.account
        where ca.active
        order by r.id`,
    )
    const meta = await firmMeta(tx, p.firm)
    let evaluated = 0
    let movementsNeeded = 0
    let skipped = 0
    for (const r of reqs.rows) {
      const freq = ((r.recalculation_schedule as { frequency?: string })?.frequency ?? 'monthly')
      const windowDays = FREQUENCY_DAYS[freq] ?? 28
      if (r.last_calc !== null) {
        const ageMs = Date.now() - new Date(r.last_calc as string).getTime()
        if (ageMs < windowDays * 86_400_000) {
          skipped++
          continue
        }
      }
      const decl = await setAsideDeclaration(tx, r.formula_pack_version as number)
      if (decl === null) {
        // the pinned version lost its declaration — impossible by immutability,
        // but never silently skip: surface loudly
        throw new OperationRefused(
          'formula_missing',
          `requirement ${r.id} points at a pack version with no set-aside formula`,
        )
      }
      const inputs: { measure: string; args: unknown[]; result: unknown }[] = []
      const ctx: EvalContext = {
        measures: SET_ASIDE_MEASURES,
        resolve: makeResolver(tx, r.account as number, meta.timezone, inputs),
        calendar: NEUTRAL_CALENDAR,
      }
      const value = await evaluateExpression(decl.body, ctx)
      const requiredCents = moneyCents(value)
      const actual = await tx.query(
        `select coalesce(sum(l.signed_amount), 0)::numeric as bal
           from deedbox.ledger_line l
           join deedbox.matter_ledger ml on ml.id = l.matter_ledger
          where ml.account = $1 and ml.ledger_kind = 'set_aside_holding'`,
        [r.account],
      )
      const actualCents = Math.round(Number(actual.rows[0].bal) * 100)
      const calc = await tx.query(
        `insert into deedbox.set_aside_calculation
           (requirement, required_balance, actual_balance, inputs)
         values ($1, $2::numeric / 100, $3::numeric / 100, $4) returning id`,
        [r.id, requiredCents, actualCents, JSON.stringify(inputs)],
      )
      await emitRegister(tx, p, {
        kind: 'record.created',
        subjectType: 'set_aside_calculation',
        subject: calc.rows[0].id as number,
        detail: {
          requirement: r.id,
          required_cents: requiredCents,
          actual_cents: actualCents,
          movement_needed: requiredCents !== actualCents,
        },
      })
      evaluated++
      if (requiredCents !== actualCents) movementsNeeded++
    }
    return { evaluated, movementsNeeded, skipped }
  })
}

// ---------------------------------------------------------------------------
// The confirmed movement — the human half.
// ---------------------------------------------------------------------------

export async function confirmSetAsideMovement(
  p: Principal,
  input: { calculation: number; pooledAccount: number },
): Promise<{ statutoryTransaction: number; pooledTransaction: number; amountCents: number }> {
  return runMoneyOperation(
    p,
    { operation: 'set_aside_move', account: input.pooledAccount },
    async (tx) => {
      await requireCapability(tx, p, 'money.record_payment')
      const calc = await tx.query(
        `select c.id, c.requirement, c.required_balance, c.actual_balance, c.movement_transaction,
                r.account as statutory_account
           from deedbox.set_aside_calculation c
           join deedbox.set_aside_requirement r on r.id = c.requirement
          where c.id = $1
          for update of c`,
        [input.calculation],
      )
      if (calc.rowCount === 0) throw new OperationRefused('not_found', 'no calculation by that id')
      const row = calc.rows[0]
      if (row.movement_transaction !== null) {
        throw new OperationRefused('already_moved', 'this calculation already has its movement')
      }
      const requiredCents = Math.round(Number(row.required_balance) * 100)
      const actualCents = Math.round(Number(row.actual_balance) * 100)
      const deltaCents = requiredCents - actualCents
      if (deltaCents === 0) {
        throw new OperationRefused('no_movement_needed', 'required equals actual — nothing to move')
      }
      const pooled = await tx.query(
        `select account_kind, active from deedbox.client_account where id = $1`,
        [input.pooledAccount],
      )
      if (
        pooled.rowCount === 0 ||
        pooled.rows[0].account_kind !== 'pooled' ||
        !pooled.rows[0].active
      ) {
        throw new OperationRefused('wrong_account_kind', 'the counterparty is an active pooled account')
      }
      const contra = await tx.query(
        `select id from deedbox.matter_ledger where account = $1 and ledger_kind = 'set_aside_contra'`,
        [input.pooledAccount],
      )
      let contraLedger: number
      if (contra.rowCount === 0) {
        const c = await tx.query(
          `insert into deedbox.matter_ledger (account, ledger_kind)
           values ($1, 'set_aside_contra') returning id`,
          [input.pooledAccount],
        )
        contraLedger = c.rows[0].id as number
      } else {
        contraLedger = contra.rows[0].id as number
      }
      const holding = await tx.query(
        `select id from deedbox.matter_ledger where account = $1 and ledger_kind = 'set_aside_holding'`,
        [row.statutory_account],
      )
      if (holding.rowCount === 0) {
        throw new OperationRefused('integrity_refusal', 'the statutory account has no holding ledger')
      }
      const holdingLedger = holding.rows[0].id as number

      // the authorisation row: the confirming holder, recorded
      const auth = await tx.query(
        `insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision, note)
         values ('set_aside_move', $1, $2, 'approved', 'set-aside movement confirmed') returning id`,
        [input.calculation, p.id],
      )
      const authId = auth.rows[0].id as number
      const amount = Math.abs(deltaCents) / 100
      const sign = deltaCents > 0 ? 1 : -1 // top-up moves pooled → statutory
      const reason = `set-aside ${sign > 0 ? 'top-up' : 'release'} for calculation ${input.calculation}`

      const statTxn = await tx.query(`select deedbox.post_money_transaction($1,$2,$3,$4,$5,$6,$7,$8)`, [
        'set_aside_move',
        isoToday((await firmMeta(tx, p.firm)).timezone),
        p.id,
        'set_aside_calculation',
        input.calculation,
        JSON.stringify([
          { side: 'cash_book', account: row.statutory_account, signed_amount: (sign * amount).toFixed(2) },
          {
            side: 'matter_ledger',
            account: row.statutory_account,
            matter_ledger: holdingLedger,
            signed_amount: (sign * amount).toFixed(2),
          },
        ]),
        reason,
        authId,
      ])
      const pooledTxn = await tx.query(`select deedbox.post_money_transaction($1,$2,$3,$4,$5,$6,$7,$8)`, [
        'set_aside_move',
        isoToday((await firmMeta(tx, p.firm)).timezone),
        p.id,
        'set_aside_calculation',
        input.calculation,
        JSON.stringify([
          { side: 'cash_book', account: input.pooledAccount, signed_amount: (-sign * amount).toFixed(2) },
          {
            side: 'matter_ledger',
            account: input.pooledAccount,
            matter_ledger: contraLedger,
            signed_amount: (-sign * amount).toFixed(2),
          },
        ]),
        reason,
        authId,
      ])
      const statId = statTxn.rows[0].post_money_transaction as number
      const pooledId = pooledTxn.rows[0].post_money_transaction as number

      // the calculation's ONE permitted mutation
      await tx.query(
        `update deedbox.set_aside_calculation set movement_transaction = $2 where id = $1`,
        [input.calculation, statId],
      )
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'set_aside_calculation',
        subject: input.calculation,
        detail: {
          before: { movement_transaction: null },
          after: { movement_transaction: statId, paired_with: pooledId, amount_cents: sign * Math.abs(deltaCents) },
        },
      })
      return {
        statutoryTransaction: statId,
        pooledTransaction: pooledId,
        amountCents: sign * Math.abs(deltaCents),
      }
    },
  )
}
