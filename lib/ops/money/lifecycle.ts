// Ledger lifecycle: open ledger (explicit), close / reopen ledger, and
// create / deactivate client account. A ledger closes only clean — zero
// balance, no active earmark, no outstanding instrument on its
// transactions, no open dormant case — and its closing_copy (the full
// reproducible ledger) is generated and stored BEFORE the status flip,
// in the same transaction. Reopen is privileged with a mandatory
// reason, only while the matter is open. Account deactivation stands
// behind the schema's own guards (zero book, every ledger closed,
// certified final-position reconciliation).

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'
import { ensureLedgerInTx } from './receipts'
import { createHash } from 'node:crypto'

/** Open a ledger explicitly (first receipts also auto-open). */
export async function openLedger(
  p: Principal,
  input: { matter: number; account: number },
): Promise<{ id: number; created: boolean }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.receive')
    return ensureLedgerInTx(tx, p, input.matter, input.account)
  })
}

/** Close a ledger: clean, with its closing copy stored first. */
export async function closeLedger(p: Principal, input: { ledger: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_accounts')
    const l = await tx.query(
      `select id, matter, account, status, ledger_number from deedbox.matter_ledger
        where id = $1 for update`,
      [input.ledger],
    )
    if (l.rowCount === 0) throw new OperationRefused('not_found', 'ledger not found')
    if (l.rows[0].status !== 'open') throw new OperationRefused('not_open', 'the ledger is already closed')

    const balance = await tx.query(`select deedbox.ledger_balance($1) as b`, [input.ledger])
    if (Math.round(Number(balance.rows[0].b) * 100) !== 0) {
      throw new OperationRefused(
        'balance_remains',
        `the ledger holds ${Number(balance.rows[0].b).toFixed(2)} — a ledger closes at exactly zero`,
      )
    }
    const earmarks = await tx.query(
      `select count(*)::int as n from deedbox.earmark where matter_ledger = $1 and state = 'active'`,
      [input.ledger],
    )
    if ((earmarks.rows[0].n as number) > 0) {
      throw new OperationRefused('earmarks_active', 'release the active earmarks first')
    }
    const outstanding = await tx.query(
      `select count(*)::int as n from deedbox.instrument i
        where i.state in ('created','stale','received','banked')
          and exists (select 1 from deedbox.ledger_line ll
                       where ll.transaction = i.transaction and ll.matter_ledger = $1)`,
      [input.ledger],
    )
    if ((outstanding.rows[0].n as number) > 0) {
      throw new OperationRefused(
        'instruments_outstanding',
        `${outstanding.rows[0].n} instrument(s) on this ledger sit outside a terminal state`,
      )
    }
    const dormant = await tx.query(
      `select count(*)::int as n from deedbox.dormant_case
        where matter_ledger = $1 and state not in ('remitted','resolved')`,
      [input.ledger],
    )
    if ((dormant.rows[0].n as number) > 0) {
      throw new OperationRefused('dormant_case_open', 'resolve the open dormant-money case first')
    }

    // the closing copy — the full reproducible ledger — BEFORE the flip
    const lines = await tx.query(
      `select ll.entry_no, ll.signed_amount, ll.running_balance, t.txn_kind,
              t.effective_date::text as effective_date, t.entered_at, t.reason
         from deedbox.ledger_line ll
         join deedbox.money_transaction t on t.id = ll.transaction
        where ll.matter_ledger = $1
        order by ll.entry_no`,
      [input.ledger],
    )
    const copy = JSON.stringify({
      document: 'ledger_closing_copy',
      ledger: input.ledger,
      ledger_number: l.rows[0].ledger_number,
      closed_by: p.id,
      lines: lines.rows,
      final_balance: 0,
    })
    const artefact = await tx.query(
      `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
       values ('ledger_closing_copy', $1, $2, 'application/json', $3) returning id`,
      [copy, createHash('sha256').update(copy).digest('hex'), Buffer.byteLength(copy)],
    )
    await tx.query(
      `update deedbox.matter_ledger
          set status = 'closed', closed_at = now(), closing_copy = $2
        where id = $1`,
      [input.ledger, String(artefact.rows[0].id)],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter_ledger',
      subject: input.ledger,
      matter: l.rows[0].matter as number,
      privileged: true,
      artefact: String(artefact.rows[0].id),
      detail: { before: { status: 'open' }, after: { status: 'closed' } },
    })
  })
}

/** Privileged reopen, reason required, matter open. */
export async function reopenLedger(
  p: Principal,
  input: { ledger: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a reopen carries its reason')
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_accounts')
    const l = await tx.query(
      `select ml.id, ml.matter, ml.status, m.status as matter_status
         from deedbox.matter_ledger ml join deedbox.matter m on m.id = ml.matter
        where ml.id = $1 for update of ml`,
      [input.ledger],
    )
    if (l.rowCount === 0) throw new OperationRefused('not_found', 'ledger not found')
    if (l.rows[0].status !== 'closed') throw new OperationRefused('not_closed', 'only a closed ledger reopens')
    if (l.rows[0].matter_status !== 'open' && l.rows[0].matter_status !== 'on_hold') {
      throw new OperationRefused('matter_not_open', 'a ledger reopens only while its matter is open')
    }
    await tx.query(
      `update deedbox.matter_ledger
          set status = 'open', closed_at = null, closing_copy = null,
              reopened_count = reopened_count + 1
        where id = $1`,
      [input.ledger],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter_ledger',
      subject: input.ledger,
      matter: l.rows[0].matter as number,
      privileged: true,
      reason: input.reason,
      detail: { before: { status: 'closed' }, after: { status: 'open' } },
    })
  })
}

/** Create a client account. */
export async function createClientAccount(
  p: Principal,
  input: {
    name: string
    accountKind: 'pooled' | 'separate_per_matter' | 'statutory_set_aside'
    linkedMatter?: number
  },
): Promise<{ id: number }> {
  requireStaff(p)
  if (!input.name.trim()) throw new OperationRefused('name_required', 'an account carries its label')
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_accounts')
    const r = await tx.query(
      `insert into deedbox.client_account (name, account_kind, linked_matter)
       values ($1, $2, $3) returning id`,
      [input.name, input.accountKind, input.linkedMatter ?? null],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'client_account',
      subject: r.rows[0].id as number,
      privileged: true,
      detail: { before: null, after: { name: input.name, account_kind: input.accountKind } },
    })
    return { id: r.rows[0].id as number }
  })
}

/** Deactivate; the schema's guards stand behind this. */
export async function deactivateClientAccount(
  p: Principal,
  input: { account: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a deactivation carries its reason')
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_accounts')
    const r = await tx.query(
      `update deedbox.client_account
          set active = false, deactivated_at = now(), deactivated_by = $2
        where id = $1 and active
        returning id`,
      [input.account, p.id],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_active', 'no active account by that id')
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'client_account',
      subject: input.account,
      privileged: true,
      reason: input.reason,
      detail: { before: { active: true }, after: { active: false } },
    })
  })
}
