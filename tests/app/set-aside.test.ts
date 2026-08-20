// Statutory set-aside + the restricted expression evaluator: exact
// arithmetic (rationals — floats never touch a formula), the closed
// operator set with typed refusals, and the full set-aside arc —
// requirement over a pack-declared formula, the evidence-only scheduled
// recalculation, and the confirmed PAIRED movement (statutory holding +
// pooled contra, one authorisation, one database transaction), linked to
// the calculation by its one permitted mutation.
//
// Cross-suite contract: runs after security, before workflow. Declares a
// synthetic pack version for ITS OWN fixture firm (money.set_aside is
// neutral-absent everywhere else — no other suite's firm is touched).
// Flips no settings. firm.held_total is INSTALLATION-global by design (the
// installation IS the firm), so on the shared scratch it sums every prior
// suite's client money: this suite measures that baseline first, funds
// ceil(baseline/9) + $750 so the pooled account always covers the required
// movement, and asserts exact cents RELATIVE to the baseline — never an
// absolute installation total (the fixture law, paid for on first gate run:
// expected 75, got 734).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  evaluateExpression,
  moneyCents,
  NEUTRAL_CALENDAR,
  type EvalContext,
  type Value,
} from '@/lib/ops/config/expression'
import {
  recordMoneyReceipt,
  createClientAccount,
  establishSetAsideRequirement,
  confirmSetAsideMovement,
} from '@/lib/ops/money'
import { runJob } from '@/lib/jobs/registry'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal

const lit = (v: string | number | boolean, type: string) => ({ lit: v, type })
const op = (o: string, ...args: unknown[]) => ({ op: o, args })
const fn = (f: string, ...args: unknown[]) => ({ fn: f, args })
const measure = (m: string, ...args: unknown[]) => ({ measure: m, args })

/** A context with stubbed measures for the pure evaluator tests. */
function stubCtx(values: Record<string, Value | null>): EvalContext {
  return {
    measures: new Set(Object.keys(values)),
    resolve: async (name) => values[name] ?? null,
    calendar: NEUTRAL_CALENDAR,
  }
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'sas')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

// ---------------------------------------------------------------------------
// The evaluator — pure.
// ---------------------------------------------------------------------------

describe('the restricted expression evaluator', () => {
  const empty = stubCtx({})

  it('arithmetic is exact — no float ever taints a formula', async () => {
    const sum = await evaluateExpression(
      op('=', op('+', lit('0.1', 'decimal'), lit('0.2', 'decimal')), lit('0.3', 'decimal')),
      empty,
    )
    expect(sum).toEqual({ t: 'boolean', v: true })
    const thirds = await evaluateExpression(
      op('=', op('*', op('/', lit('1', 'integer'), lit('3', 'integer')), lit('3', 'integer')), lit('1', 'integer')),
      empty,
    )
    expect(thirds).toEqual({ t: 'boolean', v: true })
  })

  it('round is the only narrowing: modes behave, money demands it', async () => {
    const halfUp = await evaluateExpression(
      fn('round', lit('2.345', 'decimal'), lit('2', 'integer'), lit('half_up', 'text')),
      empty,
    )
    expect(halfUp).toEqual({ t: 'decimal', v: { p: 47n, q: 20n } }) // 2.35
    const negHalf = await evaluateExpression(
      fn('round', lit('-2.345', 'decimal'), lit('2', 'integer'), lit('half_up', 'text')),
      empty,
    )
    expect(negHalf).toEqual({ t: 'decimal', v: { p: -47n, q: 20n } }) // away from zero
    const up = await evaluateExpression(
      fn('round', lit('2.341', 'decimal'), lit('2', 'integer'), lit('up', 'text')),
      empty,
    )
    expect(up).toEqual({ t: 'decimal', v: { p: 47n, q: 20n } })
    const down = await evaluateExpression(
      fn('round', lit('2.349', 'decimal'), lit('2', 'integer'), lit('down', 'text')),
      empty,
    )
    expect(down).toEqual({ t: 'decimal', v: { p: 117n, q: 50n } }) // 2.34

    // money that never met an explicit round refuses at the exit
    const unrounded = await evaluateExpression(
      op('*', lit('100.00', 'money'), lit('0.1', 'decimal')),
      empty,
    )
    expect(() => moneyCents(unrounded)).toThrow(/explicit round/)
    const rounded = await evaluateExpression(
      fn('round', op('*', lit('100.00', 'money'), lit('0.1', 'decimal')), lit('2', 'integer'), lit('half_up', 'text')),
      empty,
    )
    expect(moneyCents(rounded)).toBe(1000)
  })

  it('pct, if, min, max, abs and percent literals compose', async () => {
    const v = await evaluateExpression(
      fn(
        'round',
        fn('pct', lit('750.00', 'money'), lit('10%', 'percent')),
        lit('2', 'integer'),
        lit('half_up', 'text'),
      ),
      empty,
    )
    expect(moneyCents(v)).toBe(7500)
    const picked = await evaluateExpression(
      fn('if', op('>', lit('2', 'integer'), lit('1', 'integer')), lit('5', 'integer'), lit('9', 'integer')),
      empty,
    )
    expect(picked).toEqual({ t: 'integer', v: 5n })
    const m = await evaluateExpression(
      fn('max', lit('1.5', 'decimal'), lit('2', 'integer'), fn('abs', lit('-3', 'integer'))),
      empty,
    )
    expect(m).toEqual({ t: 'integer', v: 3n })
  })

  it('data conditions refuse typed; unbound measures refuse by name', async () => {
    await expect(
      evaluateExpression(op('/', lit('1', 'integer'), lit('0', 'integer')), empty),
    ).rejects.toMatchObject({ code: 'integrity_refusal' })
    const withNull = stubCtx({ 'firm.held_total': null })
    await expect(
      evaluateExpression(measure('firm.held_total', lit('2026-08-15', 'date')), withNull),
    ).rejects.toMatchObject({ code: 'integrity_refusal' })
    await expect(evaluateExpression(measure('nonsense.measure'), empty)).rejects.toMatchObject({
      code: 'measure_not_bound',
    })
    // value_or / has_value are the sanctioned null handling
    const fallback = await evaluateExpression(
      fn('value_or', measure('firm.held_total', lit('2026-08-15', 'date')), lit('0.00', 'money')),
      withNull,
    )
    expect(moneyCents(fallback)).toBe(0)
    const has = await evaluateExpression(
      fn('has_value', measure('firm.held_total', lit('2026-08-15', 'date'))),
      withNull,
    )
    expect(has).toEqual({ t: 'boolean', v: false })
  })

  it('depth and node caps hold', async () => {
    let deep: unknown = lit('1', 'integer')
    for (let i = 0; i < 33; i++) deep = op('neg', deep)
    await expect(evaluateExpression(deep, empty)).rejects.toMatchObject({
      code: 'expression_invalid',
    })
    const wide = op('and', ...Array.from({ length: 520 }, () => lit(true, 'boolean')))
    await expect(evaluateExpression(wide, empty)).rejects.toThrow(/512 nodes/)
  })

  it('dates: business days on the neutral calendar, month arithmetic, in()', async () => {
    // Fri 6 Mar 2026 → Mon 9 Mar 2026: one working day in (a, b]
    const bd = await evaluateExpression(
      fn('business_days_between', lit('2026-03-06', 'date'), lit('2026-03-09', 'date')),
      empty,
    )
    expect(bd).toEqual({ t: 'duration_days', v: 1n })
    const nextBd = await evaluateExpression(
      fn('add_business_days', lit('2026-03-06', 'date'), lit('1', 'integer')),
      empty,
    )
    expect(nextBd).toEqual({ t: 'date', v: '2026-03-09' })
    const eom = await evaluateExpression(fn('month_end', lit('2026-02-10', 'date')), empty)
    expect(eom).toEqual({ t: 'date', v: '2026-02-28' })
    const found = await evaluateExpression(
      fn('in', lit('card', 'text'), { list: [lit('cash', 'text'), lit('card', 'text')] }),
      empty,
    )
    expect(found).toEqual({ t: 'boolean', v: true })
    await expect(
      evaluateExpression(op('<', lit('a', 'text'), lit('b', 'text')), empty),
    ).rejects.toMatchObject({ code: 'expression_invalid' })
  })
})

// ---------------------------------------------------------------------------
// The set-aside arc end to end.
// ---------------------------------------------------------------------------

describe('requirement, recalculation, confirmed movement', () => {
  let statutory: number
  let calcId: number
  let fundingCents: number
  let requiredCents: number

  it('a requirement needs an active pack that declares the formula, and a statutory account', async () => {
    const acct = await createClientAccount(P, {
      name: 'SAS statutory reserve',
      accountKind: 'statutory_set_aside',
    })
    statutory = acct.id

    // no active pack version yet on this fixture's country pack
    await expect(
      establishSetAsideRequirement(P, { account: statutory, schedule: { frequency: 'daily' } }),
    ).rejects.toMatchObject({ code: 'no_active_pack' })

    // declare 10% of client money held today, rounded to the cent
    const pv = await admin.query(
      `insert into deedbox.pack_version (pack, version)
       select id, 'sas-1' from deedbox.country_pack where code = 'xsas' returning id, pack`,
    )
    const formula = fn(
      'round',
      fn('pct', measure('firm.held_total', measure('today')), lit('10%', 'percent')),
      lit('2', 'integer'),
      lit('half_up', 'text'),
    )
    await admin.query(
      `insert into deedbox.pack_declaration (pack_version, rule_point, kind, body)
       values ($1, 'money.set_aside', 'expression_formula', $2)`,
      [pv.rows[0].id, JSON.stringify(formula)],
    )
    await admin.query(`update deedbox.country_pack set active_version = $1 where id = $2`, [
      pv.rows[0].id,
      pv.rows[0].pack,
    ])

    // a pooled account is the wrong home for a requirement
    await expect(
      establishSetAsideRequirement(P, { account: fx.account, schedule: { frequency: 'daily' } }),
    ).rejects.toMatchObject({ code: 'wrong_account_kind' })

    const r = await establishSetAsideRequirement(P, {
      account: statutory,
      schedule: { frequency: 'daily' },
    })
    expect(r.requirement).toBeGreaterThan(0)
    const holding = await admin.query(
      `select id from deedbox.matter_ledger where account = $1 and ledger_kind = 'set_aside_holding'`,
      [statutory],
    )
    expect(holding.rowCount).toBe(1)
  })

  it('the scheduled recalculation writes evidence — never money', async () => {
    // The installation-wide held baseline (the measure's own sum, minus its
    // date filter — nothing on the scratch is future-dated). Funding is
    // ceil(baseline/9) + $750, so required (10% of baseline + funding) is
    // always at least $675 below the funding — the pooled account covers
    // the movement whatever earlier suites banked.
    const base = await admin.query(
      `select coalesce(sum(l.signed_amount), 0)::numeric as held
         from deedbox.ledger_line l
         join deedbox.matter_ledger ml on ml.id = l.matter_ledger
         join deedbox.client_account ca on ca.id = ml.account
        where l.side = 'matter_ledger'
          and ml.ledger_kind = 'client_matter'
          and ca.account_kind in ('pooled','separate_per_matter')`,
    )
    const baseCents = Math.round(Number(base.rows[0].held) * 100)
    fundingCents = Math.ceil(baseCents / 9) + 75_000
    // half_up to the cent of 10% of (baseline + funding), in integer maths
    requiredCents = Math.floor((baseCents + fundingCents + 5) / 10)

    await recordMoneyReceipt(P, {
      matter: fx.matter,
      account: fx.account,
      amount: fundingCents / 100,
      method: 'electronic_transfer',
      payerDescription: 'set-aside suite funding',
    })

    const outcome = (await runJob('set-aside-recalculation', fx.firm)) as {
      evaluated: number
      movementsNeeded: number
      skipped: number
    }
    expect(outcome.evaluated).toBe(1)
    expect(outcome.movementsNeeded).toBe(1)

    const calc = await admin.query(
      `select c.id, c.required_balance, c.actual_balance, c.inputs, c.movement_transaction
         from deedbox.set_aside_calculation c
         join deedbox.set_aside_requirement r on r.id = c.requirement
        where r.account = $1
        order by c.id desc limit 1`,
      [statutory],
    )
    expect(calc.rowCount).toBe(1)
    calcId = calc.rows[0].id as number
    expect(Math.round(Number(calc.rows[0].required_balance) * 100)).toBe(requiredCents)
    expect(Number(calc.rows[0].actual_balance)).toBe(0)
    expect(calc.rows[0].movement_transaction).toBeNull()
    const inputs = calc.rows[0].inputs as { measure: string }[]
    expect(inputs.some((i) => i.measure === 'firm.held_total')).toBe(true)

    // no money moved anywhere
    const moved = await admin.query(
      `select count(*)::int as n from deedbox.money_transaction where txn_kind = 'set_aside_move'`,
    )
    expect(moved.rows[0].n).toBe(0)

    // a same-day re-run is not due (daily window) — evidence, exactly once
    const again = (await runJob('set-aside-recalculation', fx.firm)) as { evaluated: number; skipped: number }
    expect(again.evaluated).toBe(0)
    expect(again.skipped).toBe(1)
  })

  it('a confirmed movement posts the pair under one authorisation and links the calculation', async () => {
    // the counterparty must be an active pooled account
    await expect(
      confirmSetAsideMovement(P, { calculation: calcId, pooledAccount: statutory }),
    ).rejects.toMatchObject({ code: 'wrong_account_kind' })

    const r = await confirmSetAsideMovement(P, { calculation: calcId, pooledAccount: fx.account })
    expect(r.amountCents).toBe(requiredCents)

    const txns = await admin.query(
      `select t.id, t.txn_kind, t.authorisation, a.subject_type, a.decision
         from deedbox.money_transaction t
         join deedbox.payment_authorisation a on a.id = t.authorisation
        where t.id = any($1::bigint[])`,
      [[r.statutoryTransaction, r.pooledTransaction]],
    )
    expect(txns.rowCount).toBe(2)
    for (const t of txns.rows) {
      expect(t.txn_kind).toBe('set_aside_move')
      expect(t.subject_type).toBe('set_aside_move')
      expect(t.decision).toBe('approved')
    }
    expect(txns.rows[0].authorisation).toBe(txns.rows[1].authorisation)

    const holding = await admin.query(
      `select coalesce(sum(l.signed_amount),0)::numeric as bal
         from deedbox.ledger_line l join deedbox.matter_ledger ml on ml.id = l.matter_ledger
        where ml.account = $1 and ml.ledger_kind = 'set_aside_holding'`,
      [statutory],
    )
    expect(Math.round(Number(holding.rows[0].bal) * 100)).toBe(requiredCents)
    const contra = await admin.query(
      `select coalesce(sum(l.signed_amount),0)::numeric as bal
         from deedbox.ledger_line l join deedbox.matter_ledger ml on ml.id = l.matter_ledger
        where ml.account = $1 and ml.ledger_kind = 'set_aside_contra'`,
      [fx.account],
    )
    expect(Math.round(Number(contra.rows[0].bal) * 100)).toBe(-requiredCents)
    const cash = await admin.query(
      `select l.account, coalesce(sum(l.signed_amount),0)::numeric as bal
         from deedbox.ledger_line l
        where l.side = 'cash_book' and l.account = any($1::bigint[])
        group by l.account`,
      [[statutory, fx.account]],
    )
    const byAccount = new Map(
      cash.rows.map((c) => [c.account as number, Math.round(Number(c.bal) * 100)]),
    )
    expect(byAccount.get(statutory)).toBe(requiredCents)
    expect(byAccount.get(fx.account)).toBe(fundingCents - requiredCents) // funded in, required set aside

    // the client's own ledger never moved
    const client = await admin.query(
      `select coalesce(sum(l.signed_amount),0)::numeric as bal
         from deedbox.ledger_line l join deedbox.matter_ledger ml on ml.id = l.matter_ledger
        where ml.account = $1 and ml.ledger_kind = 'client_matter'`,
      [fx.account],
    )
    expect(Math.round(Number(client.rows[0].bal) * 100)).toBe(fundingCents)

    const linked = await admin.query(
      `select movement_transaction from deedbox.set_aside_calculation where id = $1`,
      [calcId],
    )
    expect(linked.rows[0].movement_transaction).toBe(r.statutoryTransaction)

    // the one permitted mutation is spent
    await expect(
      confirmSetAsideMovement(P, { calculation: calcId, pooledAccount: fx.account }),
    ).rejects.toMatchObject({ code: 'already_moved' })
  })

  it('a calculation at equilibrium refuses movement typed', async () => {
    const req = await admin.query(
      `select id from deedbox.set_aside_requirement where account = $1`,
      [statutory],
    )
    const even = await admin.query(
      `insert into deedbox.set_aside_calculation (requirement, required_balance, actual_balance, inputs)
       values ($1, 75, 75, '[]'::jsonb) returning id`,
      [req.rows[0].id],
    )
    await expect(
      confirmSetAsideMovement(P, { calculation: even.rows[0].id as number, pooledAccount: fx.account }),
    ).rejects.toMatchObject({ code: 'no_movement_needed' })
  })
})
