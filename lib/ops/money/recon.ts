// Bank statement lines and the reconciliation workspace. Lines are owned by
// the account, insert-only, feed-idempotent; an erroneous manual line
// before certification is corrected by a CONTRA line, never edited. The
// workspace: one in-progress build per account whose only verbs are
// creating/dissolving match groups and creating/resolving/carrying typed
// exceptions. CERTIFICATION IS IN THE DATABASE — the equation to the cent,
// full coverage, member uniqueness across certified history, priors
// resolved-or-carried, the snapshot self-computed, covered instruments
// transitioned — so certify here is the capability gate, the status flip,
// and the privileged register entry; no adjusting mechanism exists and an
// unexplainable difference is refused with the itemised figures.
//
// Implementation notes: the build generates instrument-backed
// unpresented-payment exception rows from the instrument register (states
// created/stale — the two populations are the same rows by construction)
// and carries forward every prior open exception as successor rows with
// lineage and the ORIGINAL arising date; non-instrument unpresented
// payments and unbanked receipts are excepted by the workspace verbs as the
// operator works the build.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability, hasCapability } from '@/lib/ops/shared'

function cents(x: number | string): number {
  return Math.round(Number(x) * 100)
}

export interface StatementLineInput {
  lineDate: string
  amount: number
  description: string
  bankRef?: string
  feedRef?: string
}

/** Ingest statement lines (feed idempotent; manual per-row). */
export async function ingestBankStatementLines(
  p: Principal,
  input: {
    account: number
    source: 'bank_feed' | 'manual' | 'import'
    lines: StatementLineInput[]
  },
): Promise<{ inserted: number[]; replayed: number }> {
  if (input.lines.length === 0) {
    throw new OperationRefused('nothing_to_ingest', 'supply at least one line')
  }
  return withPrincipal(p, async (tx) => {
    if (p.kind === 'staff') {
      await requireCapability(tx, p, 'money.manage_accounts')
    } else if (p.kind !== 'system_job' && p.kind !== 'integration_key') {
      throw new OperationRefused('channel_only', 'statement lines arrive from the feed or accounts staff')
    }
    const inserted: number[] = []
    let replayed = 0
    for (const line of input.lines) {
      if (line.amount === 0) {
        throw new OperationRefused('bad_amount', 'a statement line is never zero')
      }
      if (input.source === 'bank_feed' && !line.feedRef?.trim()) {
        throw new OperationRefused('feed_ref_required', 'feed lines carry their feed reference')
      }
      if (line.feedRef) {
        const dup = await tx.query(
          `select id from deedbox.bank_statement_line where account = $1 and feed_ref = $2`,
          [input.account, line.feedRef],
        )
        if (dup.rowCount! > 0) {
          replayed += 1 // a replayed feed line is a no-op
          continue
        }
      }
      const r = await tx.query(
        `insert into deedbox.bank_statement_line
           (account, line_date, amount, description, bank_ref, source, feed_ref)
         values ($1, $2::date, $3, $4, $5, $6, $7) returning id`,
        [
          input.account,
          line.lineDate,
          line.amount,
          line.description,
          line.bankRef ?? null,
          input.source,
          line.feedRef ?? null,
        ],
      )
      inserted.push(r.rows[0].id as number)
    }
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'bank_statement_batch',
      subject: input.account,
      detail: { source: input.source, inserted: inserted.length, replayed },
    })
    return { inserted, replayed }
  })
}

/**
 * Build — the in-progress workspace: one per account; the
 * instrument-backed unpresented population generated from the instrument
 * register; every prior open exception carried forward with lineage.
 */
export async function buildReconciliation(
  p: Principal,
  input: { account: number; statementDate: string; statementBalance: number },
): Promise<{ id: number; instrumentExceptions: number; carriedForward: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    if (!(await hasCapability(tx, p.id, 'money.certify_reconciliation'))) {
      await requireCapability(tx, p, 'money.manage_accounts') // build-only right
    }
    const existing = await tx.query(
      `select id from deedbox.reconciliation where account = $1 and status = 'in_progress'`,
      [input.account],
    )
    if (existing.rowCount! > 0) {
      throw new OperationRefused(
        'build_exists',
        'one in-progress reconciliation per account — a wrong build is corrected in place',
      )
    }
    const r = await tx.query(
      `insert into deedbox.reconciliation (account, statement_date, statement_balance)
       values ($1, $2::date, $3) returning id`,
      [input.account, input.statementDate, input.statementBalance],
    )
    const reconId = r.rows[0].id as number

    // the outstanding-instrument population IS the instrument-backed
    // unpresented-payment exception population, by construction — but an
    // instrument already carried as an earlier reconciliation's open
    // exception arrives through the carry-forward below (lineage and
    // original arising date), never as a fresh duplicate that would
    // strand the earlier one
    const instruments = await tx.query(
      `insert into deedbox.recon_exception
         (first_reconciliation, reconciliation, exception_type, linked_type, linked,
          amount, arising_date)
       select $1, $1, 'unpresented_payment', 'instrument', i.id, i.amount,
              t.effective_date
         from deedbox.instrument i
         join deedbox.money_transaction t on t.id = i.transaction
        where i.account = $2 and i.direction = 'outbound' and i.state in ('created','stale')
          and t.effective_date <= $3::date
          and not exists (
            select 1 from deedbox.recon_exception pe
             join deedbox.reconciliation pr on pr.id = pe.reconciliation
            where pr.account = $2 and pr.status = 'certified' and pe.state = 'open'
              and pe.linked_type = 'instrument' and pe.linked = i.id)
       returning id`,
      [reconId, input.account, input.statementDate],
    )
    // carry forward every prior open exception, lineage preserved, the
    // ORIGINAL arising date copied unchanged (ageing counts from there)
    const carried = await tx.query(
      `with priors as (
         select e.id, e.first_reconciliation, e.exception_type, e.linked_type, e.linked,
                e.amount, e.arising_date
           from deedbox.recon_exception e
           join deedbox.reconciliation pr on pr.id = e.reconciliation
          where pr.account = $2 and pr.status = 'certified' and e.state = 'open'
            and not exists (select 1 from deedbox.recon_exception s
                             where s.reconciliation = $1
                               and s.linked_type = e.linked_type and s.linked = e.linked)
       ), successors as (
         insert into deedbox.recon_exception
           (first_reconciliation, reconciliation, exception_type, linked_type, linked,
            amount, arising_date)
         select p2.first_reconciliation, $1, p2.exception_type, p2.linked_type, p2.linked,
                p2.amount, p2.arising_date
           from priors p2
         returning id, linked_type, linked
       )
       update deedbox.recon_exception e
          set state = 'carried_forward', carried_to = s.id
         from successors s, priors p3
        where e.id = p3.id and s.linked_type = p3.linked_type and s.linked = p3.linked
       returning e.id`,
      [reconId, input.account],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'reconciliation',
      subject: reconId,
      detail: {
        account: input.account,
        statement_date: input.statementDate,
        statement_balance: input.statementBalance,
        instrument_exceptions: instruments.rowCount,
        carried_forward: carried.rowCount,
      },
    })
    return {
      id: reconId,
      instrumentExceptions: instruments.rowCount!,
      carriedForward: carried.rowCount!,
    }
  })
}

async function inProgressRecon(tx: Tx, reconId: number): Promise<{ id: number; account: number }> {
  const r = await tx.query(
    `select id, account, status from deedbox.reconciliation where id = $1 for update`,
    [reconId],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'reconciliation not found')
  if (r.rows[0].status !== 'in_progress') {
    throw new OperationRefused('certified', 'a certified reconciliation is locked forever')
  }
  return { id: r.rows[0].id as number, account: r.rows[0].account as number }
}

/** Match — create a group joining statement lines to transactions. */
export async function createMatchGroup(
  p: Principal,
  input: { reconciliation: number; statementLines: number[]; transactions: number[] },
): Promise<{ id: number }> {
  requireStaff(p)
  if (input.statementLines.length + input.transactions.length === 0) {
    throw new OperationRefused('empty_group', 'a match group joins at least one member')
  }
  return withPrincipal(p, async (tx) => {
    const recon = await inProgressRecon(tx, input.reconciliation)
    const g = await tx.query(
      `insert into deedbox.recon_match (reconciliation) values ($1) returning id`,
      [input.reconciliation],
    )
    for (const line of input.statementLines) {
      const owned = await tx.query(
        `select 1 from deedbox.bank_statement_line where id = $1 and account = $2`,
        [line, recon.account],
      )
      if (owned.rowCount === 0) {
        throw new OperationRefused('wrong_account', `statement line ${line} belongs to another account`)
      }
      await tx.query(
        `insert into deedbox.recon_match_member (match_group, member_kind, statement_line)
         values ($1, 'statement_line', $2)`,
        [g.rows[0].id, line],
      )
    }
    for (const txnId of input.transactions) {
      await tx.query(
        `insert into deedbox.recon_match_member (match_group, member_kind, transaction)
         values ($1, 'transaction', $2)`,
        [g.rows[0].id, txnId],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'reconciliation',
      subject: input.reconciliation,
      detail: {
        match_group_created: g.rows[0].id,
        statement_lines: input.statementLines,
        transactions: input.transactions,
      },
    })
    return { id: g.rows[0].id as number }
  })
}

/** Dissolve a group while in progress. */
export async function dissolveMatchGroup(
  p: Principal,
  input: { reconciliation: number; matchGroup: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await inProgressRecon(tx, input.reconciliation)
    await tx.query(`delete from deedbox.recon_match_member where match_group = $1`, [
      input.matchGroup,
    ])
    const g = await tx.query(
      `delete from deedbox.recon_match where id = $1 and reconciliation = $2 returning id`,
      [input.matchGroup, input.reconciliation],
    )
    if (g.rowCount === 0) throw new OperationRefused('not_found', 'no such group on this build')
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'reconciliation',
      subject: input.reconciliation,
      detail: { match_group_dissolved: input.matchGroup },
    })
  })
}

/** Except — create a typed exception on the build. */
export async function createReconException(
  p: Principal,
  input: {
    reconciliation: number
    exceptionType: 'unpresented_payment' | 'unbanked_receipt' | 'bank_error'
    linkedType: 'transaction' | 'statement_line' | 'instrument'
    linked: number
    amount: number
    arisingDate: string
  },
): Promise<{ id: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await inProgressRecon(tx, input.reconciliation)
    const r = await tx.query(
      `insert into deedbox.recon_exception
         (first_reconciliation, reconciliation, exception_type, linked_type, linked,
          amount, arising_date)
       values ($1, $1, $2, $3, $4, $5, $6::date) returning id`,
      [
        input.reconciliation,
        input.exceptionType,
        input.linkedType,
        input.linked,
        input.amount,
        input.arisingDate,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'reconciliation',
      subject: input.reconciliation,
      detail: { exception_created: r.rows[0].id, type: input.exceptionType, amount: input.amount },
    })
    return { id: r.rows[0].id as number }
  })
}

/** Resolve a PRIOR certified build's open exception in this build. */
export async function resolveReconException(
  p: Principal,
  input: { reconciliation: number; exception: number; resolutionNote: string },
): Promise<void> {
  requireStaff(p)
  if (!input.resolutionNote.trim()) {
    throw new OperationRefused('note_required', 'a resolution carries its note')
  }
  await withPrincipal(p, async (tx) => {
    await inProgressRecon(tx, input.reconciliation)
    const r = await tx.query(
      `update deedbox.recon_exception
          set state = 'resolved', resolved_in = $2, resolution_note = $3
        where id = $1 and state = 'open'
        returning reconciliation`,
      [input.exception, input.reconciliation, input.resolutionNote],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_open', 'no open exception by that id')
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'reconciliation',
      subject: input.reconciliation,
      detail: { exception_resolved: input.exception, note: input.resolutionNote },
    })
  })
}

/**
 * Certify — the schema verifies everything (groups balance,
 * coverage, uniqueness, priors, THE EQUATION) and computes the snapshot;
 * refusal itemises the difference and no adjusting mechanism exists.
 */
export async function certifyReconciliation(
  p: Principal,
  input: { reconciliation: number },
): Promise<{ equationSnapshot: unknown }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.certify_reconciliation')
    const recon = await tx.query(
      `select id, account, statement_date::text as sd, statement_balance
         from deedbox.reconciliation where id = $1 and status = 'in_progress' for update`,
      [input.reconciliation],
    )
    if (recon.rowCount === 0) {
      throw new OperationRefused('not_in_progress', 'no in-progress reconciliation by that id')
    }
    // certification takes the account's serialisation via the row lock
    // above and the schema trigger's own reads; the flip does the exam
    const r = await tx.query(
      `update deedbox.reconciliation
          set status = 'certified', certified_by = $2
        where id = $1
        returning equation_snapshot`,
      [input.reconciliation, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'reconciliation',
      subject: input.reconciliation,
      privileged: true,
      detail: {
        before: { status: 'in_progress' },
        after: { status: 'certified', equation: r.rows[0].equation_snapshot },
      },
    })
    return { equationSnapshot: r.rows[0].equation_snapshot }
  })
}
