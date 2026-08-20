import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import {
  withPrincipal,
  emitRegister,
  runMoneyOperation,
  closePool,
  MoneyRefusal,
} from '@/lib/db'
import type { Principal } from '@/lib/db'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin)
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('principal context', () => {
  it('fails closed: without context the app role sees no matters', async () => {
    const c = await admin.connect()
    try {
      await c.query('begin')
      await c.query('set local role deedbox_app')
      const r = await c.query('select count(*)::int as n from deedbox.matter')
      expect(r.rows[0].n).toBe(0)
      await c.query('rollback')
    } finally {
      c.release()
    }
  })

  it('with staff context the fixture matter is visible', async () => {
    // scoped to this fixture's matter: the scratch database is shared by
    // every test file, and all_staff scope legitimately sees other fixtures
    const n = await withPrincipal(
      P,
      async (tx) => {
        const r = await tx.query('select count(*)::int as n from deedbox.matter where id = $1', [
          fx.matter,
        ])
        return r.rows[0].n as number
      },
      { readOnly: true },
    )
    expect(n).toBe(1)
  })

  it('a portal principal with no portal access sees nothing', async () => {
    const n = await withPrincipal(
      { kind: 'portal_client', id: fx.clientParty, firm: fx.firm },
      async (tx) => {
        const r = await tx.query('select count(*)::int as n from deedbox.matter')
        return r.rows[0].n as number
      },
      { readOnly: true },
    )
    expect(n).toBe(0)
  })
})

describe('register emission', () => {
  it('appends chained entries inside the business transaction', async () => {
    const ids = await withPrincipal(P, async (tx) => {
      const a = await emitRegister(tx, P, {
        kind: 'record.created',
        subjectType: 'party',
        subject: fx.clientParty,
      })
      const b = await emitRegister(tx, P, {
        kind: 'record.changed',
        subjectType: 'party',
        subject: fx.clientParty,
        detail: { before: { display_name: 'Test Client' }, after: { display_name: 'Test Client 2' } },
      })
      return [a, b]
    })
    expect(ids[0]).toBeGreaterThan(0)
    expect(ids[1]).toBeGreaterThan(ids[0])

    const rows = await admin.query(
      `select id, seq, prev_hash, entry_hash, actor_kind, actor
         from deedbox.register_entry where id = any($1) order by seq`,
      [[ids[0], ids[1]]],
    )
    expect(rows.rowCount).toBe(2)
    // the second entry chains off the first
    expect(rows.rows[1].prev_hash).toBe(rows.rows[0].entry_hash)
    expect(rows.rows[0].actor_kind).toBe('staff')
    expect(rows.rows[0].actor).toBe(fx.staff)

    const breaks = await admin.query('select deedbox.register_verify_chain($1) as b', [fx.firm])
    expect(breaks.rows[0].b).toBe(0)
  })

  it('refuses a privileged entry without before and after values', async () => {
    await expect(
      withPrincipal(P, (tx) =>
        emitRegister(tx, P, {
          kind: 'restriction.changed',
          subjectType: 'matter',
          subject: fx.matter,
          matter: fx.matter,
          reason: 'plumbing test',
          detail: { after: { grants: [] } }, // missing "before"
        }),
      ),
    ).rejects.toThrow(/privileged register write refused/)
  })

  it('refuses a reason-required kind without a reason, and the abort takes the whole transaction', async () => {
    await expect(
      withPrincipal(P, async (tx) => {
        await tx.query(`insert into deedbox.office (name) values ('Doomed Office')`)
        await emitRegister(tx, P, {
          kind: 'restriction.changed',
          subjectType: 'matter',
          subject: fx.matter,
          matter: fx.matter,
          detail: { before: {}, after: {} },
        })
      }),
    ).rejects.toThrow(/requires a reason/)
    // no business change may commit unrecorded: the office insert died too
    const r = await admin.query(`select count(*)::int as n from deedbox.office where name = 'Doomed Office'`)
    expect(r.rows[0].n).toBe(0)
  })
})

describe('ceremony flags', () => {
  it('a money-authorisation capability grant refuses without the ceremony and lands with it', async () => {
    const role = await admin.query(
      `insert into deedbox.role (name) values ('Ceremony Test Role') returning id`,
    )
    const cap = await admin.query(
      `select key from deedbox.capability where money_authorisation order by key limit 1`,
    )
    const roleId = role.rows[0].id
    const capKey = cap.rows[0].key

    await expect(
      withPrincipal(P, (tx) =>
        tx.query(`insert into deedbox.role_capability (role, capability) values ($1, $2)`, [
          roleId,
          capKey,
        ]),
      ),
    ).rejects.toThrow(/explicit grant operation/)

    await withPrincipal(
      P,
      (tx) =>
        tx.query(`insert into deedbox.role_capability (role, capability) values ($1, $2)`, [
          roleId,
          capKey,
        ]),
      { ceremonies: ['explicit_money_grant'] },
    )
    const r = await admin.query(
      `select count(*)::int as n from deedbox.role_capability where role = $1 and capability = $2`,
      [roleId, capKey],
    )
    expect(r.rows[0].n).toBe(1)
  })
})

describe('the refusal-capture protocol', () => {
  it('posts an opening receipt (the world the refusal will be attempted in)', async () => {
    await withPrincipal(P, async (tx) => {
      const r = await tx.query(
        `select deedbox.post_money_transaction('receipt', current_date, $1, 'money_receipt', 900001, $2::jsonb) as id`,
        [
          fx.staff,
          JSON.stringify([
            { side: 'cash_book', account: fx.account, signed_amount: 500.0 },
            { side: 'matter_ledger', account: fx.account, matter_ledger: fx.ledger, signed_amount: 500.0 },
          ]),
        ],
      )
      await emitRegister(tx, P, {
        kind: 'money.transaction_posted',
        subjectType: 'money_transaction',
        subject: r.rows[0].id,
        matter: fx.matter,
      })
    })
    const bal = await admin.query('select deedbox.ledger_balance($1) as b', [fx.ledger])
    expect(Number(bal.rows[0].b)).toBe(500)
  })

  it('captures a refused overdraw in a second committed transaction', async () => {
    let refusal: MoneyRefusal | undefined
    try {
      await runMoneyOperation(
        P,
        {
          account: fx.account,
          matterLedger: fx.ledger,
          operation: { kind: 'payment_out', amount: 600.0, note: 'plumbing overdraw attempt' },
        },
        async (tx) => {
          await tx.query(
            `select deedbox.post_money_transaction('payment_out', current_date, $1, 'money_payment', 900002, $2::jsonb, 'plumbing overdraw attempt', $3)`,
            [
              fx.staff,
              JSON.stringify([
                { side: 'cash_book', account: fx.account, signed_amount: -600.0 },
                { side: 'matter_ledger', account: fx.account, matter_ledger: fx.ledger, signed_amount: -600.0 },
              ]),
              fx.approvedAuthorisation,
            ],
          )
        },
      )
    } catch (e) {
      if (e instanceof MoneyRefusal) refusal = e
      else throw e
    }

    // the typed refusal reached the caller
    expect(refusal).toBeDefined()
    expect(refusal!.reason).toBe('would_go_below_zero')
    expect(refusal!.refusalId).toBeGreaterThan(0)

    // transaction 1 left nothing: no payment transaction, balance untouched
    const t = await admin.query(
      `select count(*)::int as n from deedbox.money_transaction where source_type = 'money_payment' and source = 900002`,
    )
    expect(t.rows[0].n).toBe(0)
    const bal = await admin.query('select deedbox.ledger_balance($1) as b', [fx.ledger])
    expect(Number(bal.rows[0].b)).toBe(500)

    // transaction 2 committed the evidence: the typed refusal row…
    const ref = await admin.query(`select * from deedbox.refused_operation where id = $1`, [
      refusal!.refusalId,
    ])
    expect(ref.rowCount).toBe(1)
    expect(ref.rows[0].refusal_reason).toBe('would_go_below_zero')
    expect(ref.rows[0].account).toBe(fx.account)
    expect(ref.rows[0].matter_ledger).toBe(fx.ledger)
    expect(ref.rows[0].attempted_by).toBe(fx.staff)
    expect(ref.rows[0].attempted_by_kind).toBe('staff')

    // …and its register entry, on an unbroken chain
    const reg = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'money.refusal_recorded'
          and subject_type = 'refused_operation' and subject = $1`,
      [refusal!.refusalId],
    )
    expect(reg.rows[0].n).toBe(1)
    const breaks = await admin.query('select deedbox.register_verify_chain($1) as b', [fx.firm])
    expect(breaks.rows[0].b).toBe(0)
  })

  it('does not capture an unclassifiable error as a refusal', async () => {
    const before = await admin.query(`select count(*)::int as n from deedbox.refused_operation`)
    await expect(
      runMoneyOperation(
        P,
        { account: fx.account, operation: { kind: 'nonsense' } },
        async (tx) => {
          await tx.query('select * from deedbox.this_table_does_not_exist')
        },
      ),
    ).rejects.toThrow(/does not exist/)
    const after = await admin.query(`select count(*)::int as n from deedbox.refused_operation`)
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})
