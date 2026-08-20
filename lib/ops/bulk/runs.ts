// The generic bulk machinery: dry-run, commit, reverse. The concrete kinds
// this slice ships are the matters multi-select set (close / reopen / hold /
// resume); merge, date-proposal confirmation, slot re-resolution and import
// reversal ride the same bulk-run record layer through their own domains'
// operations.
//
// Implementation notes:
//   * Prepare returns the dry-run WITHOUT writing a bulk-run row — the
//     "prepared" draft lives on the screen, exactly the merge precedent. The
//     schema's bulk_operation guard freezes reversible_until at insert and
//     forbids hard deletes, so a prepared row could neither restart its
//     window at commit nor be discarded as an ephemeral draft; inserting at
//     commit honours both. Dry-run fidelity is held by the
//     commit's per-item before-state verification instead.
//   * Bulk close with `matter.close_requires_approval` on refuses at
//     prepare with a typed message: a multi-select close cannot silently
//     manufacture a pile of pending approval requests — items close one at
//     a time through the request ceremony when the firm demands approval.
//   * The reversal's undo of a close replays a reopen with an auto-reason
//     naming the bulk reversal; the undo of a reopen replays the direct
//     close path, whose guard may block the item individually.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability, hasCapability, settingBool, settingText } from '@/lib/ops/shared'
import {
  closeMatterDirectInTx,
  reopenMatterInTx,
  holdMatterInTx,
  resumeMatterInTx,
  archiveMatterInTx,
  simulateCloseInTx,
} from '@/lib/ops/matters/matterLifecycle'

export type BulkMatterKind = 'matter_close' | 'matter_reopen' | 'matter_hold' | 'matter_resume'

interface KindRule {
  capability: string | null // null = ordinary staff edit rights
  fromStatuses: string[]
  afterStatus: string
}

const KINDS: Record<BulkMatterKind, KindRule> = {
  matter_close: { capability: 'matter.close', fromStatuses: ['open', 'on_hold'], afterStatus: 'closed' },
  matter_reopen: { capability: 'matter.reopen', fromStatuses: ['closed', 'archived'], afterStatus: 'open' },
  matter_hold: { capability: null, fromStatuses: ['open'], afterStatus: 'on_hold' },
  matter_resume: { capability: null, fromStatuses: ['on_hold'], afterStatus: 'open' },
}

export interface BulkDryRunItem {
  matter: number
  matterNumber?: string
  before?: { status: string }
  after?: { status: string }
  willSkip?: string
}

export interface BulkDryRun {
  kind: BulkMatterKind
  items: BulkDryRunItem[]
  included: number
  skipped: number
}

/** Prepare: simulate every item, nothing written. */
export async function dryRunBulk(
  p: Principal,
  input: { kind: BulkMatterKind; matters: number[] },
): Promise<BulkDryRun> {
  requireStaff(p)
  const rule = KINDS[input.kind]
  if (!rule) throw new OperationRefused('unknown_kind', `no bulk handler for ${input.kind}`)
  if (input.matters.length === 0) {
    throw new OperationRefused('empty_selection', 'a bulk run needs at least one item')
  }
  return withPrincipal(
    p,
    async (tx) => {
      if (rule.capability && !(await hasCapability(tx, p.id, rule.capability))) {
        throw new OperationRefused('capability_missing', `this operation requires ${rule.capability}`)
      }
      if (input.kind === 'matter_close' && (await settingBool(tx, 'matter.close_requires_approval'))) {
        throw new OperationRefused(
          'close_requires_approval',
          'this firm requires close approval — matters close one at a time through the request ceremony',
        )
      }
      const items: BulkDryRunItem[] = []
      for (const matterId of input.matters) {
        // the predicate hides invisible matters: an empty read = skip listed
        const m = await tx.query(
          `select id, matter_number, status from deedbox.matter where id = $1`,
          [matterId],
        )
        if (m.rowCount === 0) {
          items.push({ matter: matterId, willSkip: 'not visible to you' })
          continue
        }
        const status = m.rows[0].status as string
        if (!rule.fromStatuses.includes(status)) {
          items.push({
            matter: matterId,
            matterNumber: m.rows[0].matter_number as string,
            willSkip: `a ${status} matter cannot ${input.kind.replace('matter_', '')}`,
          })
          continue
        }
        if (input.kind === 'matter_close') {
          const sim = await simulateCloseInTx(tx, matterId)
          if (sim.refusals.length > 0) {
            items.push({
              matter: matterId,
              matterNumber: m.rows[0].matter_number as string,
              willSkip: `close would refuse: ${sim.refusals.join('; ')}`,
            })
            continue
          }
        }
        items.push({
          matter: matterId,
          matterNumber: m.rows[0].matter_number as string,
          before: { status },
          after: { status: rule.afterStatus },
        })
      }
      const included = items.filter((i) => !i.willSkip).length
      return { kind: input.kind, items, included, skipped: items.length - included }
    },
    { readOnly: true },
  )
}

/**
 * Commit, one transaction. Every included item's current state must
 * still match its dry-run before-image (mismatches are re-listed and the run
 * must be re-prepared); every write goes through the owning domain's core so
 * all rules fire; a hard failure rolls back the whole commit. One bulk-run
 * record with per-item before/after; ONE bulk.committed register entry
 * carrying the manifest, emitted last.
 */
export async function commitBulk(
  p: Principal,
  input: { dryRun: BulkDryRun; note?: string; reason?: string },
): Promise<{ bulkOperation: number; executed: number; skipped: number }> {
  requireStaff(p)
  const rule = KINDS[input.dryRun.kind]
  if (!rule) throw new OperationRefused('unknown_kind', `no bulk handler for ${input.dryRun.kind}`)
  if (input.dryRun.kind === 'matter_reopen' && !input.reason?.trim()) {
    throw new OperationRefused('reason_required', 'reopening matters requires a reason')
  }
  const included = input.dryRun.items.filter((i) => !i.willSkip)
  if (included.length === 0) {
    throw new OperationRefused('nothing_to_do', 'every item in this run is marked to skip')
  }
  return withPrincipal(p, async (tx) => {
    if (rule.capability) await requireCapability(tx, p, rule.capability)
    if (input.dryRun.kind === 'matter_close' && (await settingBool(tx, 'matter.close_requires_approval'))) {
      throw new OperationRefused(
        'close_requires_approval',
        'this firm requires close approval — matters close one at a time through the request ceremony',
      )
    }

    // the committed writes equal the dry-run summary — every
    // item still in its before-state, or the whole run is re-prepared
    const mismatches: string[] = []
    for (const it of included) {
      const m = await tx.query(`select status from deedbox.matter where id = $1`, [it.matter])
      if (m.rowCount === 0 || m.rows[0].status !== it.before!.status) {
        mismatches.push(
          `matter ${it.matterNumber ?? it.matter}: now ${m.rows[0]?.status ?? 'not visible'}, was ${it.before!.status}`,
        )
      }
    }
    if (mismatches.length > 0) {
      throw new OperationRefused(
        're_prepare',
        `items changed since the dry run — re-prepare: ${mismatches.join('; ')}`,
      )
    }

    const windowDays = Number((await settingText(tx, 'undo.bulk_window_days')) ?? '7')
    const op = await tx.query(
      `insert into deedbox.bulk_operation
         (operation_kind, dry_run_summary, committed_at, committed_by, reversible_until)
       values ($1, $2, now(), $3, now() + make_interval(days => $4))
       returning id`,
      [input.dryRun.kind, JSON.stringify(input.dryRun), p.id, windowDays],
    )
    const opId = op.rows[0].id as number

    for (const it of included) {
      switch (input.dryRun.kind) {
        case 'matter_close':
          await closeMatterDirectInTx(tx, p, { matter: it.matter, note: input.note })
          break
        case 'matter_reopen':
          await reopenMatterInTx(tx, p, { matter: it.matter, reason: input.reason! })
          break
        case 'matter_hold':
          await holdMatterInTx(tx, p, { matter: it.matter })
          break
        case 'matter_resume':
          await resumeMatterInTx(tx, p, { matter: it.matter })
          break
      }
      await tx.query(
        `insert into deedbox.bulk_operation_item (operation, entity_type, entity, before, after)
         values ($1, 'matter.status', $2, $3, $4)`,
        [opId, it.matter, JSON.stringify(it.before), JSON.stringify(it.after)],
      )
    }

    await emitRegister(tx, p, {
      kind: 'bulk.committed',
      subjectType: 'bulk_operation',
      subject: opId,
      detail: {
        kind: input.dryRun.kind,
        items: included.map((i) => ({ matter: i.matter, before: i.before, after: i.after })),
        skipped: input.dryRun.items.filter((i) => i.willSkip).map((i) => ({ matter: i.matter, reason: i.willSkip })),
      },
    })
    return { bulkOperation: opId, executed: included.length, skipped: input.dryRun.items.length - included.length }
  })
}

/**
 * Reverse within the window. Per item, newest-first: a record still
 * in its after-state replays its inverse through the owning domain's core; a
 * touched record blocks individually with its reason. One transaction, one
 * bulk.reversed register entry with per-item outcomes.
 */
export async function reverseBulk(
  p: Principal,
  input: { bulkOperation: number; reason: string },
): Promise<{ reversed: number; blocked: number }> {
  requireStaff(p)
  if (!input.reason?.trim()) {
    throw new OperationRefused('reason_required', 'a bulk reversal always carries a reason')
  }
  return withPrincipal(p, async (tx) => {
    const op = await tx.query(
      `select id, operation_kind, committed_at, committed_by, reversible_until, reversed_at
         from deedbox.bulk_operation where id = $1 for update`,
      [input.bulkOperation],
    )
    if (op.rowCount === 0) throw new OperationRefused('not_found', 'bulk run not found')
    const run = op.rows[0]
    const kind = run.operation_kind as BulkMatterKind
    const rule = KINDS[kind]
    if (!rule) {
      throw new OperationRefused(
        'unknown_kind',
        `this run's kind (${run.operation_kind}) reverses through its own domain's operation`,
      )
    }
    if (run.committed_at === null) throw new OperationRefused('not_committed', 'only committed runs reverse')
    if (run.reversed_at !== null) {
      throw new OperationRefused('already_reversed', 'this run has already had its reversal')
    }
    const windowOpen = await tx.query(`select $1::timestamptz >= now() as open`, [run.reversible_until])
    if (!windowOpen.rows[0].open) {
      throw new OperationRefused('window_closed', 'the undo window for this run has closed')
    }
    // the committer, or an administrator holding the underlying capability
    if (run.committed_by !== p.id) {
      const cap = rule.capability ?? 'matter.close'
      if (!(await hasCapability(tx, p.id, cap))) {
        throw new OperationRefused(
          'not_yours',
          'only the committer, or a holder of the underlying capability, reverses a run',
        )
      }
    }

    const items = await tx.query(
      `select id, entity, before, after from deedbox.bulk_operation_item
        where operation = $1 and reversal_outcome is null order by id desc`,
      [input.bulkOperation],
    )
    let reversed = 0
    let blocked = 0
    const outcomes: { matter: number; outcome: string; reason?: string }[] = []
    for (const it of items.rows) {
      const matterId = it.entity as number
      const cur = await tx.query(`select status from deedbox.matter where id = $1`, [matterId])
      const afterStatus = (it.after as { status: string }).status
      const beforeStatus = (it.before as { status: string }).status
      let block: string | null = null
      if (cur.rowCount === 0) {
        block = 'matter not visible to the reverser'
      } else if (cur.rows[0].status !== afterStatus) {
        block = `status is now ${cur.rows[0].status}; the run left it ${afterStatus}`
      } else {
        try {
          const autoReason = `bulk reversal of run ${input.bulkOperation}: ${input.reason}`
          if (afterStatus === 'closed' && rule.fromStatuses.includes(beforeStatus)) {
            // undo of a close = a reopen with the auto-reason
            await reopenMatterInTx(tx, p, { matter: matterId, reason: autoReason })
            if (beforeStatus === 'on_hold') await holdMatterInTx(tx, p, { matter: matterId })
          } else if (kind === 'matter_reopen') {
            // undo of a reopen = the direct close path; its guard may block;
            // a before-image of archived is restored whole (close, then archive)
            await closeMatterDirectInTx(tx, p, { matter: matterId, note: autoReason })
            if (beforeStatus === 'archived') {
              await archiveMatterInTx(tx, p, { matter: matterId })
            }
          } else if (kind === 'matter_hold') {
            await resumeMatterInTx(tx, p, { matter: matterId })
          } else if (kind === 'matter_resume') {
            await holdMatterInTx(tx, p, { matter: matterId })
          }
        } catch (err) {
          if (err instanceof OperationRefused) {
            block = `${err.code}: ${err.message}`
          } else {
            throw err
          }
        }
      }
      if (block === null) {
        await tx.query(
          `update deedbox.bulk_operation_item set reversal_outcome = 'reversed' where id = $1`,
          [it.id],
        )
        outcomes.push({ matter: matterId, outcome: 'reversed' })
        reversed++
      } else {
        await tx.query(
          `update deedbox.bulk_operation_item
              set reversal_outcome = 'blocked', block_reason = $2 where id = $1`,
          [it.id, block],
        )
        outcomes.push({ matter: matterId, outcome: 'blocked', reason: block })
        blocked++
      }
    }

    await tx.query(
      `update deedbox.bulk_operation set reversed_at = now(), reversed_by = $2 where id = $1`,
      [input.bulkOperation, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'bulk.reversed',
      subjectType: 'bulk_operation',
      subject: input.bulkOperation,
      reason: input.reason,
      detail: { kind, outcomes, reversed, blocked },
    })
    return { reversed, blocked }
  })
}

/** The "my bulk runs" panel read: reversible runs of mine, newest first. */
export async function listReversibleRuns(
  p: Principal,
): Promise<{ id: number; kind: string; committedAt: string; reversibleUntil: string; items: number }[]> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select o.id, o.operation_kind, o.committed_at, o.reversible_until,
                (select count(*)::int from deedbox.bulk_operation_item i where i.operation = o.id) as n
           from deedbox.bulk_operation o
          where o.committed_by = $1 and o.committed_at is not null
            and o.reversed_at is null and o.reversible_until >= now()
          order by o.committed_at desc`,
        [p.id],
      )
      return r.rows.map((row) => ({
        id: row.id as number,
        kind: row.operation_kind as string,
        committedAt: String(row.committed_at),
        reversibleUntil: String(row.reversible_until),
        items: row.n as number,
      }))
    },
    { readOnly: true },
  )
}
