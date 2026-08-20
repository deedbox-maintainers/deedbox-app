// The import batch engine: the validate-only batch and the real batch, plus
// the client-money delegation. One engine, two modes, identical
// appliers — the guarantee is structural.
//
// Mode mechanics:
//   * validate_only — the ENTIRE pipeline runs inside one transaction that
//     is deliberately rolled back at the end (a sentinel throw); per-record
//     failures roll back to a savepoint so later records still run. Outside
//     that transaction, the batch row (born completed, mode validate_only),
//     the per-record dispositions, the report artefact and the register
//     entry are written. Nothing else persists — and gapless
//     numbers consumed inside the rolled-back transaction are released with
//     it, so a validate run consumes nothing.
//   * real, non-money — the batch row is born running; every record commits
//     in its OWN transaction (a refusal is itemised and the batch
//     continues); a final transaction stamps completed with the report.
//   * real, money — ONE transaction holds the whole replay and the batch's
//     own completion: any integrity failure rolls everything back (zero
//     money rows persist) and a second transaction records the refused
//     batch with the itemised report. The money replay's refusal is ALSO
//     captured by the refusal-capture protocol (the money domain's posture:
//     every refused posting is evidence), so the refusal register and the
//     batch report agree.

import type { Principal, Tx } from '@/lib/db'
import {
  withPrincipal,
  emitRegister,
  OperationRefused,
  runMoneyOperation,
  MoneyRefusal,
} from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'
import {
  applyClientRecord,
  applyMatterRecord,
  applyTimeEntryRecord,
  applyBillRecord,
  applyOtherRecord,
  applyDocumentRecord,
  applyNoteRecord,
  applyMoneyFullHistory,
  applyOpeningBalances,
  type ClientRecordData,
  type MatterRecordData,
  type TimeEntryRecordData,
  type BillRecordData,
  type OtherRecordData,
  type DocumentRecordData,
  type NoteRecordData,
  type FullHistoryPayload,
  type OpeningBalancesPayload,
  type ImportContext,
  type RecordOutcome,
} from './pipeline'

export type RecordDomain =
  | 'clients'
  | 'matters'
  | 'bills'
  | 'time'
  | 'client_money_full_history'
  | 'client_money_opening_balances'
  | 'other'
  | 'documents'
  | 'notes'

export interface ImportBatchInput {
  recordDomain: RecordDomain
  sourceSystem: string
  migration?: number
  mapping?: number
  /** Non-money domains: the parsed records. */
  records?: { source_ref: string; data: unknown }[]
  /** client_money_full_history */
  fullHistory?: FullHistoryPayload
  /** client_money_opening_balances */
  openingBalances?: OpeningBalancesPayload
}

export interface ImportBatchResult {
  batch: number
  state: 'completed' | 'refused'
  outcomes: RecordOutcome[]
  counts: Record<string, number>
}

/** The deliberate rollback that ends a validate-only pipeline run. */
class ValidateOnlyRollback extends Error {
  constructor(readonly outcomes: RecordOutcome[]) {
    super('validate-only pipeline rolled back by design')
  }
}

function countsOf(outcomes: RecordOutcome[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const o of outcomes) c[o.disposition] = (c[o.disposition] ?? 0) + 1
  return c
}

async function storeReportArtefact(
  tx: Tx,
  content: unknown,
): Promise<number> {
  const body = JSON.stringify(content)
  const r = await tx.query(
    `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
     values ('import_batch_report', $1, $2, 'application/json', $3) returning id`,
    [body, createHash('sha256').update(body).digest('hex'), Buffer.byteLength(body)],
  )
  return r.rows[0].id as number
}

async function applyOneRecord(
  tx: Tx,
  p: Principal,
  ctx: ImportContext,
  domain: RecordDomain,
  rec: { source_ref: string; data: unknown },
): Promise<RecordOutcome> {
  switch (domain) {
    case 'clients':
      return applyClientRecord(tx, p, ctx, rec.source_ref, rec.data as ClientRecordData)
    case 'matters':
      return applyMatterRecord(tx, p, ctx, rec.source_ref, rec.data as MatterRecordData)
    case 'time':
      return applyTimeEntryRecord(tx, p, ctx, rec.source_ref, rec.data as TimeEntryRecordData)
    case 'bills':
      return applyBillRecord(tx, p, ctx, rec.source_ref, rec.data as BillRecordData)
    case 'other':
      return applyOtherRecord(tx, p, ctx, rec.source_ref, rec.data as OtherRecordData)
    case 'documents':
      return applyDocumentRecord(tx, p, ctx, rec.source_ref, rec.data as DocumentRecordData)
    case 'notes':
      return applyNoteRecord(tx, p, ctx, rec.source_ref, rec.data as NoteRecordData)
    default:
      throw new OperationRefused(
        'record_domain_not_supported',
        `no applier exists for the ${domain} record domain`,
      )
  }
}

/** Run an import batch in either mode. */
export async function runImportBatch(
  p: Principal,
  input: ImportBatchInput,
  opts: { mode: 'validate_only' | 'real' },
): Promise<ImportBatchResult> {
  const isMoney =
    input.recordDomain === 'client_money_full_history' ||
    input.recordDomain === 'client_money_opening_balances'
  if (isMoney) {
    if (input.recordDomain === 'client_money_full_history' && !input.fullHistory) {
      throw new OperationRefused('payload_required', 'full-history batches carry the fullHistory payload')
    }
    if (input.recordDomain === 'client_money_opening_balances' && !input.openingBalances) {
      throw new OperationRefused('payload_required', 'opening-balance batches carry the openingBalances payload')
    }
  } else if (!input.records || input.records.length === 0) {
    throw new OperationRefused('records_required', 'an import batch carries at least one record')
  }
  await withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'import.execute')
    },
    { readOnly: true },
  )

  return isMoney ? runMoneyBatch(p, input, opts.mode) : runRecordBatch(p, input, opts.mode)
}

// ---------------------------------------------------------------------------

async function runRecordBatch(
  p: Principal,
  input: ImportBatchInput,
  mode: 'validate_only' | 'real',
): Promise<ImportBatchResult> {
  // An archive lands on closed matters — that is the point of an archive —
  // and the schema rightly demands the edit-closed ceremony for document
  // writes there. The import batch IS the deliberate act, so its document
  // transactions carry the ceremony; every other domain runs without it.
  const txOpts =
    input.recordDomain === 'documents' ? { ceremonies: ['edit_closed' as const] } : undefined

  if (mode === 'validate_only') {
    let outcomes: RecordOutcome[] = []
    try {
      await withPrincipal(
        p,
        async (tx) => {
        const collected: RecordOutcome[] = []
        // batch id 0: the rolled-back simulation stamps a placeholder marker;
        // nothing it writes survives the sentinel below
        const ctx: ImportContext = { batchId: 0, sourceSystem: input.sourceSystem }
        for (const rec of input.records!) {
          await tx.query(`savepoint import_record`)
          try {
            collected.push(await applyOneRecord(tx, p, ctx, input.recordDomain, rec))
            await tx.query(`release savepoint import_record`)
          } catch (err) {
            await tx.query(`rollback to savepoint import_record`)
            collected.push({
              sourceRef: rec.source_ref,
              disposition: 'refused',
              message: err instanceof Error ? err.message : String(err),
            })
          }
        }
        throw new ValidateOnlyRollback(collected)
        },
        txOpts,
      )
    } catch (err) {
      if (!(err instanceof ValidateOnlyRollback)) throw err
      outcomes = err.outcomes
    }
    return recordBatchRow(p, input, 'validate_only', outcomes, 'completed')
  }

  // real mode: the batch row first, then one transaction per record
  const batchId = await withPrincipal(p, async (tx) => {
    const b = await tx.query(
      `insert into deedbox.import_batch (migration, mapping, record_domain, mode, source_system)
       values ($1, $2, $3, 'real', $4) returning id`,
      [input.migration ?? null, input.mapping ?? null, input.recordDomain, input.sourceSystem],
    )
    return b.rows[0].id as number
  })
  const ctx: ImportContext = { batchId, sourceSystem: input.sourceSystem }
  const outcomes: RecordOutcome[] = []
  for (const rec of input.records!) {
    try {
      const outcome = await withPrincipal(
        p,
        async (tx) => {
          const o = await applyOneRecord(tx, p, ctx, input.recordDomain, rec)
          await insertImportRecord(tx, batchId, o)
          return o
        },
        txOpts,
      )
      outcomes.push(outcome)
    } catch (err) {
      const refused: RecordOutcome = {
        sourceRef: rec.source_ref,
        disposition: 'refused',
        message: err instanceof Error ? err.message : String(err),
      }
      outcomes.push(refused)
      await withPrincipal(p, async (tx) => insertImportRecord(tx, batchId, refused))
    }
  }
  const counts = countsOf(outcomes)
  await withPrincipal(p, async (tx) => {
    const artefact = await storeReportArtefact(tx, {
      batch: batchId,
      mode: 'real',
      record_domain: input.recordDomain,
      source_system: input.sourceSystem,
      outcomes,
    })
    await tx.query(
      `update deedbox.import_batch
          set state = 'completed', report_artefact = $2, counts = $3, finished_at = now()
        where id = $1`,
      [batchId, String(artefact), JSON.stringify(counts)],
    )
    await emitRegister(tx, p, {
      kind: 'import.batch_applied',
      subjectType: 'import_batch',
      subject: batchId,
      artefact: String(artefact),
      detail: { mode: 'real', record_domain: input.recordDomain, counts },
    })
  })
  return { batch: batchId, state: 'completed', outcomes, counts }
}

/** Validate-only batches: the terminal row, dispositions and report, one transaction. */
async function recordBatchRow(
  p: Principal,
  input: ImportBatchInput,
  mode: 'validate_only',
  outcomes: RecordOutcome[],
  state: 'completed' | 'refused',
): Promise<ImportBatchResult> {
  const counts = countsOf(outcomes)
  const batchId = await withPrincipal(p, async (tx) => {
    const artefact = await storeReportArtefact(tx, {
      mode,
      record_domain: input.recordDomain,
      source_system: input.sourceSystem,
      outcomes,
    })
    const b = await tx.query(
      `insert into deedbox.import_batch
         (migration, mapping, record_domain, mode, state, report_artefact, counts, source_system, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now()) returning id`,
      [
        input.migration ?? null,
        input.mapping ?? null,
        input.recordDomain,
        mode,
        state,
        String(artefact),
        JSON.stringify(counts),
        input.sourceSystem,
      ],
    )
    const id = b.rows[0].id as number
    for (const o of outcomes) await insertImportRecord(tx, id, o)
    await emitRegister(tx, p, {
      kind: 'import.batch_applied',
      subjectType: 'import_batch',
      subject: id,
      artefact: String(artefact),
      detail: { mode, validate: true, record_domain: input.recordDomain, counts },
    })
    return id
  })
  return { batch: batchId, state, outcomes, counts }
}

async function insertImportRecord(tx: Tx, batchId: number, o: RecordOutcome): Promise<void> {
  await tx.query(
    `insert into deedbox.import_record (batch, source_ref, disposition, message, target_type, target)
     values ($1, $2, $3, $4, $5, $6)`,
    [batchId, o.sourceRef, o.disposition, o.message ?? null, o.targetType ?? null, o.target ?? null],
  )
}

// ---------------------------------------------------------------------------

async function runMoneyBatch(
  p: Principal,
  input: ImportBatchInput,
  mode: 'validate_only' | 'real',
): Promise<ImportBatchResult> {
  const account =
    input.recordDomain === 'client_money_full_history'
      ? input.fullHistory!.account
      : input.openingBalances!.account
  // the closure survives the replay transaction's abort: the itemised report
  // of a refused batch is exactly what had been decided when the refusal hit
  const outcomes: RecordOutcome[] = []
  let batchId = 0

  const body = async (tx: Tx): Promise<void> => {
    outcomes.length = 0
    const b = await tx.query(
      `insert into deedbox.import_batch (migration, mapping, record_domain, mode, source_system)
       values ($1, $2, $3, $4, $5) returning id`,
      [
        input.migration ?? null,
        input.mapping ?? null,
        input.recordDomain,
        mode === 'validate_only' ? 'validate_only' : 'real',
        input.sourceSystem,
      ],
    )
    batchId = b.rows[0].id as number
    const ctx: ImportContext = { batchId, sourceSystem: input.sourceSystem }
    let boundary: unknown = null
    if (input.recordDomain === 'client_money_full_history') {
      await applyMoneyFullHistory(tx, p, ctx, input.fullHistory!, outcomes)
    } else {
      const r = await applyOpeningBalances(tx, p, ctx, input.openingBalances!, outcomes)
      boundary = r.boundary
    }
    const counts = countsOf(outcomes)
    const artefact = await storeReportArtefact(tx, {
      batch: batchId,
      mode,
      record_domain: input.recordDomain,
      source_system: input.sourceSystem,
      outcomes,
      boundary_reconciliation: boundary,
    })
    for (const o of outcomes) await insertImportRecord(tx, batchId, o)
    await tx.query(
      `update deedbox.import_batch
          set state = 'completed', report_artefact = $2, counts = $3, finished_at = now()
        where id = $1`,
      [batchId, String(artefact), JSON.stringify(counts)],
    )
    await emitRegister(tx, p, {
      kind: 'import.batch_applied',
      subjectType: 'import_batch',
      subject: batchId,
      artefact: String(artefact),
      detail: {
        mode,
        validate: mode === 'validate_only',
        record_domain: input.recordDomain,
        counts,
      },
    })
    if (mode === 'validate_only') {
      throw new ValidateOnlyRollback([...outcomes])
    }
  }

  try {
    if (mode === 'real') {
      // the replay transaction IS the staging posture; a guard refusal is
      // captured by the refusal-capture protocol in the wrapper before we
      // record the refused batch
      await runMoneyOperation(p, { account, operation: { import_batch: input.recordDomain } }, body)
    } else {
      await withPrincipal(p, body)
    }
  } catch (err) {
    if (err instanceof ValidateOnlyRollback) {
      return recordMoneyBatchRow(p, input, 'validate_only', err.outcomes, 'completed')
    }
    const message =
      err instanceof MoneyRefusal || err instanceof OperationRefused || err instanceof Error
        ? err.message
        : String(err)
    const refusedOutcomes: RecordOutcome[] = [
      ...outcomes.filter((o) => o.disposition !== 'accepted'),
      // accepted outcomes of the aborted transaction did not survive it —
      // the report says so instead of claiming rows that do not exist
      ...outcomes
        .filter((o) => o.disposition === 'accepted')
        .map((o) => ({
          sourceRef: o.sourceRef,
          disposition: 'refused' as const,
          message: 'rolled back: a later movement refused the batch',
        })),
      { sourceRef: '(batch)', disposition: 'refused' as const, message },
    ]
    return recordMoneyBatchRow(
      p,
      input,
      mode === 'validate_only' ? 'validate_only' : 'real',
      refusedOutcomes,
      'refused',
    )
  }
  return { batch: batchId, state: 'completed', outcomes, counts: countsOf(outcomes) }
}

/** The refused/validate money batch row: evidence outside the discarded staging. */
async function recordMoneyBatchRow(
  p: Principal,
  input: ImportBatchInput,
  mode: 'validate_only' | 'real',
  outcomes: RecordOutcome[],
  state: 'completed' | 'refused',
): Promise<ImportBatchResult> {
  const counts = countsOf(outcomes)
  const batchId = await withPrincipal(p, async (tx) => {
    const artefact = await storeReportArtefact(tx, {
      mode,
      record_domain: input.recordDomain,
      source_system: input.sourceSystem,
      state,
      outcomes,
    })
    const b = await tx.query(
      `insert into deedbox.import_batch
         (migration, mapping, record_domain, mode, state, report_artefact, counts, source_system, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now()) returning id`,
      [
        input.migration ?? null,
        input.mapping ?? null,
        input.recordDomain,
        mode,
        state,
        String(artefact),
        JSON.stringify(counts),
        input.sourceSystem,
      ],
    )
    const id = b.rows[0].id as number
    for (const o of outcomes) await insertImportRecord(tx, id, o)
    await emitRegister(tx, p, {
      kind: state === 'refused' ? 'record.created' : 'import.batch_applied',
      subjectType: 'import_batch',
      subject: id,
      artefact: String(artefact),
      detail: { mode, validate: mode === 'validate_only', state, counts },
    })
    return id
  })
  return { batch: batchId, state, outcomes, counts }
}
