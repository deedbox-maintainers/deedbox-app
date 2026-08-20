// Billing runs. Build executes the filter under the actor's predicate and
// drafts one bill group per included matter in its OWN transaction (a
// failure excludes that matter with its reason, honestly listed); matters
// with an open billing hold, closed or archived matters, and matters with
// nothing unbilled are excluded with reasons in the filter_snapshot. Issue
// iterates groups, issuing each group in its own transaction — gapless
// integrity holds per commit; the first hard failure stops the iteration,
// reports its position, and leaves the remaining drafts in review. Abandon
// sweeps the draft-group abandonment across the run in one transaction.
//
// Implementation note: the general filter enumerates matters THAT HAVE
// unbilled work (a firm-wide "nothing unbilled" listing would name every
// matter in the firm); matters the caller names explicitly are always listed
// — included, or excluded with the reason they cannot bill.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { createDraftBillGroup, abandonGroupInTx } from './drafting'
import { issueBillGroup } from './issue'

export interface RunFilters {
  practiceArea?: number
  office?: number
  responsibleLawyer?: number
  /** Explicit matter list; every named matter appears in the snapshot. */
  matters?: number[]
  /**
   * The WIP cut-off (ISO date): only work dated on or before it — time by
   * work_date, disbursements by incurred_date — is drafted; later work stays
   * unbilled for the next run. Absent = everything unbilled.
   */
  throughDate?: string
}

interface Exclusion {
  matter: number
  reason: string
}

async function candidateMatters(
  tx: Tx,
  filters: RunFilters,
): Promise<{ included: number[]; excluded: Exclusion[] }> {
  const named = filters.matters ?? []
  const rows = await tx.query(
    `select m.id, m.status, m.billing_hold,
            exists (select 1 from deedbox.time_entry te
                     where te.matter = m.id and te.billed_state = 'unbilled'
                       and te.deleted_at is null
                       and ($5::date is null or te.work_date <= $5))
         or exists (select 1 from deedbox.disbursement d
                     where d.matter = m.id and d.billed_state = 'unbilled'
                       and d.billable and d.deleted_at is null
                       and ($5::date is null or d.incurred_date <= $5)) as has_unbilled
       from deedbox.matter m
      where ($1::bigint is null or m.practice_area = $1)
        and ($2::bigint is null or m.office = $2)
        and ($3::bigint is null or m.responsible_lawyer = $3)
        and (cardinality($4::bigint[]) = 0 or m.id = any($4))
      order by m.id`,
    [
      filters.practiceArea ?? null,
      filters.office ?? null,
      filters.responsibleLawyer ?? null,
      named,
      filters.throughDate ?? null,
    ],
  )
  const included: number[] = []
  const excluded: Exclusion[] = []
  for (const m of rows.rows) {
    if (m.billing_hold) {
      excluded.push({ matter: m.id as number, reason: 'billing hold' })
    } else if (m.status === 'closed' || m.status === 'archived') {
      excluded.push({ matter: m.id as number, reason: `matter ${m.status}` })
    } else if (!m.has_unbilled) {
      // enumerable only when the caller named the matter
      if (named.includes(m.id as number)) {
        excluded.push({
          matter: m.id as number,
          reason: filters.throughDate ? `nothing unbilled on or before ${filters.throughDate}` : 'nothing unbilled',
        })
      }
    } else {
      included.push(m.id as number)
    }
  }
  return { included, excluded }
}

/**
 * Build — create the run, draft every included matter (one
 * transaction each), land the honest snapshot, move to review.
 */
export async function createBillingRun(
  p: Principal,
  input: { filters?: RunFilters },
): Promise<{
  run: number
  groups: { matter: number; group: number }[]
  excluded: Exclusion[]
}> {
  requireStaff(p)
  const filters = input.filters ?? {}

  // transaction 1: the run row and the selection as executed
  const { run, included, excluded } = await withPrincipal(p, async (tx) => {
    const sel = await candidateMatters(tx, filters)
    const r = await tx.query(
      `insert into deedbox.billing_run (run_by, filter_snapshot)
       values ($1, $2) returning id`,
      [p.id, JSON.stringify({ filters, phase: 'building' })],
    )
    const runId = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'billing_run',
      subject: runId,
      detail: { candidates: sel.included.length, excluded: sel.excluded.length },
    })
    return { run: runId, included: sel.included, excluded: sel.excluded }
  })

  // one transaction per included matter: draft ALL its unbilled work;
  // a failure excludes the matter with its reason and the run continues
  const groups: { matter: number; group: number }[] = []
  for (const matterId of included) {
    try {
      const items = await withPrincipal(
        p,
        async (tx) => {
          const te = await tx.query(
            `select id from deedbox.time_entry
              where matter = $1 and billed_state = 'unbilled' and deleted_at is null
                and ($2::date is null or work_date <= $2)
              order by id`,
            [matterId, filters.throughDate ?? null],
          )
          const d = await tx.query(
            `select id from deedbox.disbursement
              where matter = $1 and billed_state = 'unbilled' and billable and deleted_at is null
                and ($2::date is null or incurred_date <= $2)
              order by id`,
            [matterId, filters.throughDate ?? null],
          )
          return {
            timeEntries: te.rows.map((x) => x.id as number),
            disbursements: d.rows.map((x) => x.id as number),
          }
        },
        { readOnly: true },
      )
      const g = await createDraftBillGroup(p, {
        matter: matterId,
        timeEntries: items.timeEntries,
        disbursements: items.disbursements,
        billingRun: run,
      })
      groups.push({ matter: matterId, group: g.group })
    } catch (e) {
      if (e instanceof OperationRefused) {
        excluded.push({ matter: matterId, reason: e.message })
      } else {
        throw e
      }
    }
  }

  // final transaction: the honest snapshot, then into review
  await withPrincipal(p, async (tx) => {
    await tx.query(
      `update deedbox.billing_run
          set filter_snapshot = $2, state = 'in_review'
        where id = $1`,
      [run, JSON.stringify({ filters, included: groups, excluded })],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'billing_run',
      subject: run,
      detail: {
        before: { state: 'building' },
        after: { state: 'in_review', groups: groups.length, excluded: excluded.length },
      },
    })
  })
  return { run, groups, excluded }
}

/**
 * Issue — one group per transaction; the first hard failure
 * stops the iteration and leaves the rest in review.
 */
export async function issueBillingRun(
  p: Principal,
  input: { run: number },
): Promise<{
  issued: { group: number; bills: { id: number; billNumber: string; total: number }[] }[]
  stoppedAt: { group: number; position: number; reason: string } | null
}> {
  requireStaff(p)
  const draftGroups = await withPrincipal(
    p,
    async (tx) => {
      const run = await tx.query(`select state from deedbox.billing_run where id = $1`, [
        input.run,
      ])
      if (run.rowCount === 0) throw new OperationRefused('not_found', 'billing run not found')
      if (run.rows[0].state !== 'in_review') {
        throw new OperationRefused('wrong_state', `a ${run.rows[0].state} run cannot issue`)
      }
      const g = await tx.query(
        `select id from deedbox.bill_group
          where billing_run = $1 and state = 'draft' order by id`,
        [input.run],
      )
      return g.rows.map((x) => x.id as number)
    },
    { readOnly: true },
  )
  if (draftGroups.length === 0) {
    throw new OperationRefused('nothing_to_issue', 'the run holds no draft groups')
  }

  const issued: { group: number; bills: { id: number; billNumber: string; total: number }[] }[] = []
  let stoppedAt: { group: number; position: number; reason: string } | null = null
  for (let i = 0; i < draftGroups.length; i++) {
    try {
      const r = await issueBillGroup(p, { group: draftGroups[i] })
      issued.push({ group: draftGroups[i], bills: r.bills })
    } catch (e) {
      if (e instanceof OperationRefused) {
        stoppedAt = { group: draftGroups[i], position: i, reason: e.message }
        break
      }
      throw e
    }
  }

  await withPrincipal(p, async (tx) => {
    if (stoppedAt === null) {
      await tx.query(`update deedbox.billing_run set state = 'issued' where id = $1`, [input.run])
      await emitRegister(tx, p, {
        kind: 'bulk.committed',
        subjectType: 'billing_run',
        subject: input.run,
        detail: { groups_issued: issued.length },
      })
    } else {
      // the run stays in review; the snapshot records how far it got
      await tx.query(
        `update deedbox.billing_run
            set filter_snapshot = filter_snapshot || $2::jsonb
          where id = $1`,
        [input.run, JSON.stringify({ issue_stopped: stoppedAt, issued_before_stop: issued.length })],
      )
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'billing_run',
        subject: input.run,
        detail: { issue_stopped: stoppedAt, issued_before_stop: issued.length },
      })
    }
  })
  return { issued, stoppedAt }
}

/** Abandon — every draft group abandoned in one transaction, then the run. */
export async function abandonBillingRun(p: Principal, input: { run: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const run = await tx.query(
      `select state from deedbox.billing_run where id = $1 for update`,
      [input.run],
    )
    if (run.rowCount === 0) throw new OperationRefused('not_found', 'billing run not found')
    if (run.rows[0].state !== 'in_review') {
      throw new OperationRefused('wrong_state', `a ${run.rows[0].state} run cannot abandon`)
    }
    const groups = await tx.query(
      `select id from deedbox.bill_group where billing_run = $1 and state = 'draft' order by id`,
      [input.run],
    )
    for (const g of groups.rows) {
      await abandonGroupInTx(tx, p, g.id as number)
    }
    await tx.query(`update deedbox.billing_run set state = 'abandoned' where id = $1`, [input.run])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'billing_run',
      subject: input.run,
      detail: {
        before: { state: 'in_review' },
        after: { state: 'abandoned', groups_released: groups.rowCount },
      },
    })
  })
}
