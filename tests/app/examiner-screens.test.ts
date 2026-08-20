// Examiner workspace: schema change 0025's row policies, the header
// pinhole, restricted-read recording and the pack export's examiner
// branch, proven end-to-end — grant issued by staff, real examiner
// sign-in, session resolution, the workspace reads, the pack export,
// revocation.
//
// Cross-suite contracts (localeCompare order: after config-screens, before
// interface-outbound — ahead of every money suite): all fixture rows are
// tag-named (xexs) on the fixture's OWN account and ledger; NO database-
// global setting is flipped; the examined period runs [15, 5] days ago so
// nothing another suite posts today can fall inside it; assertions always
// filter to this fixture's ids, never global counts. The examiner grant
// expires an hour from now, so the jobs suite's expiry sweep never touches
// these sessions.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool, withPrincipal } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { recordMoneyReceipt } from '@/lib/ops/money'
import {
  grantExaminer,
  revokeExaminer,
  examinerSignIn,
  resolveSessionPrincipal,
  exportExaminationPack,
} from '@/lib/ops/security'
import {
  examinerContext,
  examinerHome,
  examinerCashBook,
  examinerLedgers,
  examinerLedger,
  examinerRecons,
  examinerTransfers,
  examinerRefusals,
  examinerIncidents,
  examinerMasterData,
} from '@/lib/reads/examiner'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let E: Principal
let grant: { id: number; secret: string }
let session: number

const dateStr = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'xexs')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }

  // the books: one movement inside the examined period, one after it
  await recordMoneyReceipt(P, {
    matter: fx.matter,
    account: fx.account,
    amount: 100,
    method: 'electronic_transfer',
    receivedDate: dateStr(10),
    payerDescription: 'In-period payer xexs',
  })
  await recordMoneyReceipt(P, {
    matter: fx.matter,
    account: fx.account,
    amount: 55,
    method: 'electronic_transfer',
    receivedDate: dateStr(2),
    payerDescription: 'Out-of-period payer xexs',
  })
  // the master-data journal: one identity change in the period, one after
  await admin.query(
    `insert into deedbox.register_entry
       (firm, occurred_at, actor_kind, actor, event_kind, subject_type, subject, matter, detail)
     values ($1, $2, 'staff', $3, 'master_data.changed', 'matter_ledger', $4, $5,
             '{"change":"client display name (xexs, in period)"}')`,
    [fx.firm, new Date(Date.now() - 10 * 86400000).toISOString(), fx.staff, fx.ledger, fx.matter],
  )
  await admin.query(
    `insert into deedbox.register_entry
       (firm, occurred_at, actor_kind, actor, event_kind, subject_type, subject, matter, detail)
     values ($1, $2, 'staff', $3, 'master_data.changed', 'matter_ledger', $4, $5,
             '{"change":"client display name (xexs, after period)"}')`,
    [fx.firm, new Date(Date.now() - 2 * 86400000).toISOString(), fx.staff, fx.ledger, fx.matter],
  )
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('the grant, sign-in and session resolution', () => {
  it('staff grant an examiner; the examiner signs in; the resolver serves the examiner principal', async () => {
    grant = await grantExaminer(P, {
      examinerName: 'Iris Examiner',
      login: 'iris.xexs',
      periodStart: dateStr(15),
      periodEnd: dateStr(5),
      startsAt: new Date(Date.now() - 3600_000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    const s = await examinerSignIn({
      login: 'iris.xexs',
      secret: grant.secret,
      firm: fx.firm,
      device: { fingerprint: 'fp-iris-xexs' },
    })
    session = s.session
    E = await resolveSessionPrincipal(session, fx.firm)
    expect(E.kind).toBe('examiner')
    expect(E.id).toBe(grant.id)
    expect(E.session).toBe(session)
  })

  it('the workspace badge names the window and the examined period', async () => {
    const ctx = await examinerContext(E)
    expect(ctx.examinerName).toBe('Iris Examiner')
    expect(ctx.periodStart).toBe(dateStr(15))
    expect(ctx.periodEnd).toBe(dateStr(5))
  })
})

describe('the period-scoped reads (over the 0025 policies)', () => {
  it('the ledger list serves the fixture ledger under the minimal header', async () => {
    const rows = await examinerLedgers(E)
    const mine = rows.find((r) => r.id === fx.ledger)
    expect(mine).toBeDefined()
    expect(mine!.client_display_name).toBe('Fixture Client xexs')
    expect(mine!.matter_reference).toBe('T-xexs-000001')
  })

  it('the ledger screen serves the in-period line and never the later one', async () => {
    const d = await examinerLedger(E, fx.ledger)
    const amounts = d.lines.map((l) => Number(l.signed_amount))
    expect(amounts).toContain(100)
    expect(amounts).not.toContain(55)
    expect(d.header?.ledger_number).toBeTruthy()
  })

  it('the cash book scopes the account side the same way', async () => {
    const d = await examinerCashBook(E, fx.account)
    const amounts = d.lines.map((l) => Number(l.signed_amount))
    expect(amounts).toContain(100)
    expect(amounts).not.toContain(55)
  })

  it('the home screen lists the account with its in-period movement', async () => {
    const d = await examinerHome(E)
    const acct = d.accounts.find((a) => a.id === fx.account)
    expect(acct).toBeDefined()
    expect(Number(acct!.period_net)).toBe(100)
  })

  it('the master-data journal serves the in-period change only', async () => {
    const rows = await examinerMasterData(E)
    const mine = rows.filter((r) => r.subject === fx.ledger)
    expect(mine.length).toBe(1)
    expect(String((mine[0].detail as { change?: string })?.change)).toContain('in period')
  })

  it('reconciliations, transfers, refusals and incidents read empty rather than refuse', async () => {
    expect((await examinerRecons(E)).filter((r) => r.account === fx.account)).toEqual([])
    expect((await examinerTransfers(E)).filter((t) => t.from_matter === fx.matter)).toEqual([])
    expect((await examinerRefusals(E)).filter((r) => r.matter === fx.matter)).toEqual([])
    expect((await examinerIncidents(E)).filter((i) => i.matter === fx.matter)).toEqual([])
  })
})

describe('confinement: identity closed, writes refused', () => {
  it('matter and party rows are structurally invisible to the examiner', async () => {
    const counts = await withPrincipal(
      E,
      async (tx) => {
        const m = await tx.query(`select count(*)::int as n from deedbox.matter where id = $1`, [
          fx.matter,
        ])
        const pt = await tx.query(`select count(*)::int as n from deedbox.party where id = $1`, [
          fx.clientParty,
        ])
        return { matter: m.rows[0].n as number, party: pt.rows[0].n as number }
      },
      { readOnly: true },
    )
    expect(counts).toEqual({ matter: 0, party: 0 })
  })

  it('a raw write under examiner context violates row security', async () => {
    await expect(
      withPrincipal(E, async (tx) => {
        await tx.query(
          `insert into deedbox.money_transaction (txn_kind, effective_date, entered_by, source_type, source)
           values ('receipt', $1::date, $2, 'test_fixture', 990001)`,
          [dateStr(10), fx.staff],
        )
      }),
    ).rejects.toThrow(/row-level security/)
  })

  it('operations refuse the examiner principal typed', async () => {
    await expect(
      recordMoneyReceipt(E, {
        matter: fx.matter,
        account: fx.account,
        amount: 10,
        method: 'electronic_transfer',
        payerDescription: 'never',
      }),
    ).rejects.toMatchObject({ code: 'staff_only' })
  })
})

describe('every read registered, once per session/record/surface', () => {
  it('the reads above produced examiner.read entries carrying their surfaces', async () => {
    const surfaceLevel = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'examiner.read' and session_ref = $1
          and matter is null and detail->>'surface' = 'examiner_home'`,
      [session],
    )
    expect(surfaceLevel.rows[0].n).toBe(1)
    const perMatter = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'examiner.read' and session_ref = $1
          and matter = $2 and detail->>'surface' = 'examiner_ledger'`,
      [session, fx.matter],
    )
    expect(perMatter.rows[0].n).toBe(1)
  })

  it('a repeated read adds nothing at the same grain', async () => {
    const before = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'examiner.read' and session_ref = $1`,
      [session],
    )
    await examinerLedger(E, fx.ledger)
    await examinerHome(E)
    const after = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'examiner.read' and session_ref = $1`,
      [session],
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})

describe('the examiner path', () => {
  it('exports the pack for the examined period with the pinhole header and the register entry', async () => {
    const r = await exportExaminationPack(E, {
      periodStart: dateStr(15),
      periodEnd: dateStr(5),
    })
    expect(r.transactions).toBeGreaterThanOrEqual(1)

    const artefact = await admin.query(
      `select content_ref from deedbox.stored_artefact where id = $1`,
      [r.artefact],
    )
    expect(String(artefact.rows[0].content_ref)).toContain('Fixture Client xexs')
    expect(String(artefact.rows[0].content_ref)).toContain('T-xexs-000001')

    const k21 = await admin.query(
      `select exported_by_kind, exported_by from deedbox.examination_pack_export
        where artefact = $1`,
      [String(r.artefact)],
    )
    expect(k21.rows[0]).toEqual({ exported_by_kind: 'examiner', exported_by: grant.id })

    const evt = await admin.query(
      `select privileged, actor_kind from deedbox.register_entry
        where event_kind = 'export.performed' and subject = $1 and actor_kind = 'examiner'`,
      [r.artefact],
    )
    expect(evt.rows[0]).toEqual({ privileged: true, actor_kind: 'examiner' })
  })

  it('refuses a period outside the grant, typed', async () => {
    await expect(
      exportExaminationPack(E, { periodStart: dateStr(15), periodEnd: dateStr(1) }),
    ).rejects.toMatchObject({ code: 'outside_access_window' })
  })

  it('the staff path still serves (the runtime policies changed nothing)', async () => {
    const r = await exportExaminationPack(P, {
      periodStart: dateStr(15),
      periodEnd: dateStr(5),
    })
    expect(r.transactions).toBeGreaterThanOrEqual(1)
  })
})

describe('revocation closes everything', () => {
  it('revoking the grant ends the session and the resolver refuses it', async () => {
    const r = await revokeExaminer(P, { grant: grant.id, reason: 'examination concluded' })
    expect(r.endedSessions).toBeGreaterThanOrEqual(1)
    await expect(resolveSessionPrincipal(session, fx.firm)).rejects.toMatchObject({
      code: 'session_ended',
    })
  })

  it('the revoked grant context reads nothing at the row level', async () => {
    const n = await withPrincipal(
      E,
      async (tx) => {
        const r = await tx.query(
          `select count(*)::int as n from deedbox.ledger_line where matter_ledger = $1`,
          [fx.ledger],
        )
        return r.rows[0].n as number
      },
      { readOnly: true },
    )
    expect(n).toBe(0)
  })
})
