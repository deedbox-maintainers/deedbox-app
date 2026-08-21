// Pay issued bills from held client money — one step composing three
// EXISTING ceremonies, none weakened: a rendered-bill entitlement per named
// bill (no money moves), then the held-funds application preview and commit
// over those matters. Every resulting transfer parks in the money
// authorisation queue exactly as a hand-built one would — the separation
// rule (or the firm's explicit self-authorisation setting) still decides
// who may approve, and the execute-time guards remain the wall.
//
// Two doors, one act: the billing-run screen passes its run (each ticked
// bill must belong to it); the bill's own screen passes just the bill.
//
// Idempotency: a bill already carrying an actionable entitlement with
// headroom is never entitled twice — re-running the step only picks up
// bills that still owe and matters that still hold available money.

import type { Principal } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { establishEntitlement } from '@/lib/ops/money'
import { previewHeldFundsApplication, commitHeldFundsApplication } from './heldFunds'

function cents(x: number | string): number {
  return Math.round(Number(x) * 100)
}

export async function applyHeldFundsToRunBills(
  p: Principal,
  input: { run: number; bills: number[] },
): Promise<{ entitled: number; awaiting: number; refused: number; matters: number }> {
  return applyHeldFundsToBills(p, input)
}

export async function applyHeldFundsToBills(
  p: Principal,
  input: { bills: number[]; run?: number },
): Promise<{ entitled: number; awaiting: number; refused: number; matters: number }> {
  requireStaff(p)
  if (input.bills.length === 0) {
    throw new OperationRefused('no_scope', 'tick at least one bill to pay from held money')
  }

  // the facts, read under the actor's own predicate: each named bill must
  // be issued, still owe, and sit on a matter with an open client ledger
  // holding available money — and, through the run door, belong to the run
  const rows = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select b.id as bill, b.matter, deedbox.bill_outstanding(b.id) as outstanding,
                l.id as ledger, deedbox.ledger_available(l.id) as available,
                exists (select 1 from deedbox.entitlement e
                         where e.bill = b.id and e.cancelled_at is null
                           and deedbox.entitlement_status(e.id) = 'actionable'
                           and e.amount - deedbox.entitlement_consumed(e.id) > 0) as already_entitled,
                exists (select 1 from deedbox.funds_application fa
                         where fa.bill = b.id and fa.item_state = 'awaiting_authorisation') as already_prepared
           from deedbox.bill b
           join deedbox.bill_group g on g.id = b.bill_group
                and ($1::int is null or g.billing_run = $1)
           left join lateral (
             select ml.id from deedbox.matter_ledger ml
              where ml.matter = b.matter and ml.ledger_kind = 'client_matter' and ml.status = 'open'
              order by deedbox.ledger_available(ml.id) desc limit 1
           ) l on true
          where b.id = any($2) and b.state = 'issued'
          order by b.id`,
        [input.run ?? null, input.bills],
      )
      if (r.rowCount === 0) {
        throw new OperationRefused(
          'not_found',
          input.run !== undefined
            ? 'none of the ticked bills are issued bills of this run'
            : 'no issued bill matches',
        )
      }
      return r.rows as {
        bill: number
        matter: number
        outstanding: string
        ledger: number | null
        available: string
        already_entitled: boolean
        already_prepared: boolean
      }[]
    },
    { readOnly: true },
  )

  let entitled = 0
  let alreadyPrepared = 0
  const matters = new Set<number>()
  for (const row of rows) {
    if (cents(row.outstanding) <= 0) continue
    if (row.ledger === null || cents(row.available) <= 0) continue
    if (row.already_prepared) {
      // a transfer for this bill already awaits authorisation — preparing a
      // second would queue the same money twice
      alreadyPrepared++
      continue
    }
    matters.add(row.matter)
    if (row.already_entitled) continue
    const amount = Math.min(cents(row.outstanding), cents(row.available)) / 100
    await establishEntitlement(p, {
      matterLedger: row.ledger,
      amount,
      basisKind: 'rendered_bill',
      bill: row.bill,
    })
    entitled++
  }
  if (matters.size === 0) {
    throw new OperationRefused(
      'nothing_payable',
      alreadyPrepared > 0
        ? 'the ticked bills already have transfers awaiting authorisation — approve them on the client-money payments screen'
        : 'none of the ticked bills can be paid from held money — nothing is owed, or no available funds are held',
    )
  }

  const preview = await previewHeldFundsApplication(p, { matters: [...matters] })
  const committed = await commitHeldFundsApplication(p, { run: preview.run })
  return {
    entitled,
    awaiting: committed.awaiting.length,
    refused: committed.refused.length,
    matters: matters.size,
  }
}

/**
 * The firm-wide sweep: FIND every issued bill still owing whose matter's
 * client ledger holds available money — nobody names the bills — record the
 * claims, and preview the run. Nothing financial moves: committing the run
 * parks one transfer per bill and every transfer still takes its
 * authorisation. A bill already claimed keeps its claim; a bill whose
 * transfer already awaits authorisation is left alone — a sweep re-run
 * never queues the same money twice.
 */
export async function prepareFirmWideHeldFunds(
  p: Principal,
): Promise<{ run: number; discovered: number; entitled: number; executable: number; refused: number }> {
  requireStaff(p)

  // the matter join is load-bearing: it puts the viewer's visibility walls
  // (office/assignment scopes, restricted matters) between them and the
  // sweep — a firm-wide run must not touch matters its author could not open
  const rows = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select b.id as bill, b.matter,
                l.id as ledger,
                deedbox.bill_outstanding(b.id) as outstanding,
                deedbox.ledger_available(l.id) as available,
                exists (select 1 from deedbox.entitlement e
                         where e.bill = b.id and e.cancelled_at is null
                           and deedbox.entitlement_status(e.id) = 'actionable'
                           and e.amount - deedbox.entitlement_consumed(e.id) > 0) as already_entitled,
                exists (select 1 from deedbox.funds_application fa
                         where fa.bill = b.id and fa.item_state = 'awaiting_authorisation') as already_prepared
           from deedbox.bill b
           join deedbox.matter m on m.id = b.matter
           join lateral (
             select ml.id from deedbox.matter_ledger ml
              where ml.matter = b.matter and ml.ledger_kind = 'client_matter' and ml.status = 'open'
              order by deedbox.ledger_available(ml.id) desc limit 1
           ) l on true
          where b.state = 'issued'
            and deedbox.bill_outstanding(b.id) > 0
            and deedbox.ledger_available(l.id) > 0
          order by b.id`,
      )
      return r.rows as {
        bill: number
        matter: number
        ledger: number
        outstanding: string
        available: string
        already_entitled: boolean
        already_prepared: boolean
      }[]
    },
    { readOnly: true },
  )

  let entitled = 0
  const matters = new Set<number>()
  for (const row of rows) {
    if (row.already_prepared) continue
    matters.add(row.matter)
    if (row.already_entitled) continue
    const amount = Math.min(cents(row.outstanding), cents(row.available)) / 100
    await establishEntitlement(p, {
      matterLedger: row.ledger,
      amount,
      basisKind: 'rendered_bill',
      bill: row.bill,
    })
    entitled++
  }
  if (matters.size === 0) {
    throw new OperationRefused(
      'nothing_payable',
      rows.length > 0
        ? 'every payable bill already has a transfer awaiting authorisation — approve them on the client-money payments screen'
        : 'no issued bill can be paid from held money — nothing is owed on a matter holding available funds',
    )
  }
  const preview = await previewHeldFundsApplication(p, { matters: [...matters] })
  return {
    run: preview.run,
    discovered: rows.length,
    entitled,
    executable: preview.executable.length,
    refused: preview.refused.length,
  }
}
