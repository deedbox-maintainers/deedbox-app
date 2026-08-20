// Reverse an import batch. The stated exception to per-item tolerance:
// strictly ALL-OR-NOTHING. If any created record has been touched by a
// non-import actor since import, NOTHING reverses, the state records
// partially_blocked, and the report names every blocker by source reference;
// a later attempt may succeed.
//
// On success, one bulk run (kind import_reversal) carries the reversal:
// client parties soft-delete through the domain posture; money history
// reverses newest-first by proper reversal transactions under the posting
// protocol (never row deletion — documents keep their numbers); import source
// references are retained as history; the batch lands state reversed; ONE
// import.batch_reversed register entry carries the run.
//
// Implementation notes:
//   * Batches whose records were UPDATES block ('updates are not
//     reversible' — no before-image is kept for them), and batches that
//     created MATTERS block on those records: the schema's word is that
//     matters are never deleted, and the matters domain ships no deletion
//     path. Both block honestly rather than half-reverse.
//   * A blocked attempt registers record.changed on the batch with the
//     blocker list; import.batch_reversed is emitted ONLY for a run that
//     actually reversed.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused, runMoneyOperation } from '@/lib/db'
import { requireCapability, settingText } from '@/lib/ops/shared'
import { touchedSinceImport } from './pipeline'

interface ReversibleRecord {
  importRecord: number
  sourceRef: string
  disposition: string
  targetType: string | null
  target: number | null
}

export async function reverseImportBatch(
  p: Principal,
  input: { batch: number; reason: string },
): Promise<{ state: 'reversed' | 'partially_blocked'; blockers: { sourceRef: string; reason: string }[] }> {
  if (!input.reason?.trim()) {
    throw new OperationRefused('reason_required', 'a batch reversal always carries a reason')
  }

  // Phase 1 — the all-or-nothing exam, read-only.
  const plan = await withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'import.reverse')
      const b = await tx.query(
        `select id, state, record_domain, source_system from deedbox.import_batch where id = $1`,
        [input.batch],
      )
      if (b.rowCount === 0) throw new OperationRefused('not_found', 'import batch not found')
      const state = b.rows[0].state as string
      if (state !== 'completed' && state !== 'partially_blocked') {
        throw new OperationRefused('wrong_state', `a ${state} batch cannot be reversed`)
      }
      const records = await tx.query(
        `select r.id, r.source_ref, r.disposition, r.target_type, r.target
           from deedbox.import_record r where r.batch = $1 order by r.id`,
        [input.batch],
      )
      const reversible: ReversibleRecord[] = []
      const blockers: { sourceRef: string; reason: string }[] = []
      for (const r of records.rows) {
        const rec: ReversibleRecord = {
          importRecord: r.id as number,
          sourceRef: r.source_ref as string,
          disposition: r.disposition as string,
          targetType: r.target_type as string | null,
          target: r.target as number | null,
        }
        if (rec.disposition === 'refused' || rec.target === null) continue // nothing was written
        if (rec.disposition === 'updated') {
          blockers.push({ sourceRef: rec.sourceRef, reason: 'updates are not reversible' })
          continue
        }
        if (rec.targetType === 'matter') {
          blockers.push({ sourceRef: rec.sourceRef, reason: 'matters are never deleted' })
          continue
        }
        const m5 = await tx.query(
          `select created_at::text as created_at from deedbox.source_reference
            where source_system = $1 and source_ref = $2 and target_type = $3`,
          [b.rows[0].source_system, rec.sourceRef, rec.targetType],
        )
        if (m5.rowCount! > 0) {
          // full microseconds — a Date round-trip truncates and makes the
          // record's own same-transaction birth events look touched
          const touched = await touchedSinceImport(
            tx,
            rec.targetType!,
            rec.target,
            m5.rows[0].created_at as string,
          )
          if (touched) {
            blockers.push({
              sourceRef: rec.sourceRef,
              reason: 'target changed since import by a non-import actor',
            })
            continue
          }
        }
        reversible.push(rec)
      }
      return {
        blockers,
        reversible,
        recordDomain: b.rows[0].record_domain as string,
        sourceSystem: b.rows[0].source_system as string,
      }
    },
    { readOnly: true },
  )

  if (plan.blockers.length > 0) {
    await withPrincipal(p, async (tx) => {
      await tx.query(`update deedbox.import_batch set state = 'partially_blocked' where id = $1`, [
        input.batch,
      ])
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'import_batch',
        subject: input.batch,
        reason: input.reason,
        detail: {
          before: { state: 'completed' },
          after: { state: 'partially_blocked' },
          blockers: plan.blockers,
        },
      })
    })
    return { state: 'partially_blocked', blockers: plan.blockers }
  }

  // Phase 2 — one transaction reverses everything, or nothing does.
  const isMoney = plan.reversible.some((r) => r.targetType === 'money_transaction')
  const body = async (tx: Tx): Promise<void> => {
    await requireCapability(tx, p, 'import.reverse')
    const windowDays = Number((await settingText(tx, 'undo.bulk_window_days')) ?? '7')
    const op = await tx.query(
      `insert into deedbox.bulk_operation
         (operation_kind, dry_run_summary, committed_at, committed_by, reversible_until)
       values ('import_reversal', $1, now(), $2, now() + make_interval(days => $3))
       returning id`,
      [
        JSON.stringify({ batch: input.batch, records: plan.reversible.length }),
        p.id,
        windowDays,
      ],
    )
    const opId = op.rows[0].id as number
    let reversalAuthorisation: number | null = null

    // newest-first: money reversals must unwind in reverse chronological
    // order so no intermediate balance dips below zero
    const ordered = [...plan.reversible].sort((a, b) => (b.target ?? 0) - (a.target ?? 0))
    for (const rec of ordered) {
      if (rec.targetType === 'party') {
        await tx.query(
          `update deedbox.party set deleted_at = now(), deleted_by = $2
            where id = $1 and deleted_at is null`,
          [rec.target, p.id],
        )
        await emitRegister(tx, p, {
          kind: 'record.soft_deleted',
          subjectType: 'party',
          subject: rec.target!,
          detail: { import_batch_reversal: input.batch },
        })
        await tx.query(
          `insert into deedbox.bulk_operation_item (operation, entity_type, entity, before, after)
           values ($1, 'party.import_reversal', $2, $3, $4)`,
          [
            opId,
            rec.target,
            JSON.stringify({ deleted: false, source_ref: rec.sourceRef }),
            JSON.stringify({ deleted: true }),
          ],
        )
      } else if (rec.targetType === 'money_transaction') {
        const t = await tx.query(
          `select t.id, t.txn_kind,
                  exists (select 1 from deedbox.money_transaction r where r.reverses = t.id) as reversed
             from deedbox.money_transaction t where t.id = $1`,
          [rec.target],
        )
        if (t.rowCount === 0) {
          throw new OperationRefused('not_found', `${rec.sourceRef}: imported transaction missing`)
        }
        if (t.rows[0].reversed) {
          throw new OperationRefused(
            'already_reversed',
            `${rec.sourceRef}: the imported transaction is already reversed`,
          )
        }
        const kind = t.rows[0].txn_kind as string
        const needsAuth = ['payment_out', 'firm_transfer', 'ledger_transfer', 'remittance', 'set_aside_move'].includes(kind)
        if (needsAuth && reversalAuthorisation === null) {
          // subject = the NEGATED batch id — same rule as the import
          // authorisation: the positive space belongs to real documents,
          // and a collision would hand one a phantom approval
          const auth = await tx.query(
            `insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision, note)
             values ('reversal', $1, $2, 'approved', $3) returning id`,
            [-input.batch, p.id, `reversal of import batch ${input.batch}`],
          )
          reversalAuthorisation = auth.rows[0].id as number
        }
        const lines = await tx.query(
          `select jsonb_agg(jsonb_build_object(
                    'side', l.side, 'account', l.account,
                    'matter_ledger', l.matter_ledger, 'signed_amount', -l.signed_amount)) as mirror
             from deedbox.ledger_line l where l.transaction = $1`,
          [rec.target],
        )
        const rev = await tx.query(
          `select deedbox.post_money_transaction(
             'reversal', current_date, $1, 'import_batch', $2, $3::jsonb, $4, $5, $6) as t`,
          [
            p.id,
            input.batch,
            JSON.stringify(lines.rows[0].mirror),
            `reversal of import batch ${input.batch}: ${input.reason}`,
            needsAuth ? reversalAuthorisation : null,
            rec.target,
          ],
        )
        await emitRegister(tx, p, {
          kind: 'money.transaction_posted',
          subjectType: 'money_transaction',
          subject: rev.rows[0].t as number,
          detail: {
            kind: 'reversal',
            reverses: rec.target,
            import_batch_reversal: input.batch,
            source_ref: rec.sourceRef,
          },
        })
        await tx.query(
          `insert into deedbox.bulk_operation_item (operation, entity_type, entity, before, after)
           values ($1, 'money_transaction.import_reversal', $2, $3, $4)`,
          [
            opId,
            rec.target,
            JSON.stringify({ transaction: rec.target, source_ref: rec.sourceRef }),
            JSON.stringify({ reversal: rev.rows[0].t }),
          ],
        )
      } else if (rec.targetType === 'note') {
        await tx.query(
          `update deedbox.note set deleted_at = now(), deleted_by = $2
            where id = $1 and deleted_at is null`,
          [rec.target, p.id],
        )
        await emitRegister(tx, p, {
          kind: 'record.soft_deleted',
          subjectType: 'note',
          subject: rec.target!,
          detail: { import_batch_reversal: input.batch },
        })
        await tx.query(
          `insert into deedbox.bulk_operation_item (operation, entity_type, entity, before, after)
           values ($1, 'note.import_reversal', $2, $3, $4)`,
          [
            opId,
            rec.target,
            JSON.stringify({ deleted: false, source_ref: rec.sourceRef }),
            JSON.stringify({ deleted: true }),
          ],
        )
      } else if (rec.targetType === 'document') {
        await tx.query(
          `update deedbox.document set soft_deleted_at = now(), soft_deleted_by = $2
            where id = $1 and soft_deleted_at is null`,
          [rec.target, p.id],
        )
        await emitRegister(tx, p, {
          kind: 'record.soft_deleted',
          subjectType: 'document',
          subject: rec.target!,
          detail: { import_batch_reversal: input.batch },
        })
        await tx.query(
          `insert into deedbox.bulk_operation_item (operation, entity_type, entity, before, after)
           values ($1, 'document.import_reversal', $2, $3, $4)`,
          [
            opId,
            rec.target,
            JSON.stringify({ deleted: false, source_ref: rec.sourceRef }),
            JSON.stringify({ deleted: true }),
          ],
        )
      } else if (rec.targetType === 'document_folder') {
        // Folders are structure, not content: their files reference them
        // forever (a soft-deleted document still points at its folder), so a
        // reversal leaves the scaffolding standing and records exactly that.
        await tx.query(
          `insert into deedbox.bulk_operation_item (operation, entity_type, entity, before, after)
           values ($1, 'document_folder.import_reversal', $2, $3, $4)`,
          [
            opId,
            rec.target,
            JSON.stringify({ source_ref: rec.sourceRef }),
            JSON.stringify({ left_standing: true }),
          ],
        )
      } else {
        throw new OperationRefused(
          'no_reverser',
          `${rec.sourceRef}: no reversal path for ${rec.targetType}`,
        )
      }
    }

    await tx.query(`update deedbox.import_batch set state = 'reversed' where id = $1`, [input.batch])
    await emitRegister(tx, p, {
      kind: 'import.batch_reversed',
      subjectType: 'import_batch',
      subject: input.batch,
      reason: input.reason,
      bulkOperation: opId,
      detail: { records: plan.reversible.length, bulk_operation: opId },
    })
  }

  if (isMoney) {
    const account = await accountOfBatch(p, input.batch)
    await runMoneyOperation(p, { account, operation: { import_batch_reversal: input.batch } }, body)
  } else {
    await withPrincipal(p, body)
  }
  return { state: 'reversed', blockers: [] }
}

/** The account a money batch's transactions live on (for the attempt record). */
async function accountOfBatch(p: Principal, batch: number): Promise<number> {
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select l.account
           from deedbox.import_record ir
           join deedbox.ledger_line l on l.transaction = ir.target
          where ir.batch = $1 and ir.target_type = 'money_transaction'
          limit 1`,
        [batch],
      )
      if (r.rowCount === 0) {
        throw new OperationRefused('not_found', 'no money transactions on this batch')
      }
      return r.rows[0].account as number
    },
    { readOnly: true },
  )
}
