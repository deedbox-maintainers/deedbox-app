// The practice bridge (JOB 23 'gl-sync'): every entry of the receivables'
// own append-only bill journal becomes exactly one balanced office-ledger
// journal, keyed by the entry id (the partial unique index makes replays
// free). Dark until the module is configured — the job returns zero
// counts rather than erring (deliberate).
//
// One-way dependency: this file reads the practice tables; nothing in the
// engine knows the office ledger exists.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'
import { glConfigInTx, purposeAccountInTx, createPostedJournalInTx, toCents, toIsoDate } from './shared'

// Which account faces accounts-receivable, by practice entry kind.
function counterPurpose(kind: string): string {
  switch (kind) {
    case 'payment_allocation':
      return 'operating_bank'
    case 'write_off':
      return 'bad_debts'
    default:
      return 'revenue_default' // issue_total, interest_charge, credit_application
  }
}

function bridgeSourceType(kind: string): string {
  switch (kind) {
    case 'payment_allocation':
      return 'bridge_payment'
    case 'credit_application':
      return 'bridge_credit'
    case 'write_off':
      return 'bridge_writeoff'
    default:
      return 'bridge_bill'
  }
}

export interface GlSyncResult {
  configured: boolean
  posted: number
  skipped: number
}

export async function runGlSync(p: Principal): Promise<GlSyncResult> {
  return withPrincipal(p, (tx) => glSyncInTx(tx, p))
}

async function glSyncInTx(tx: Tx, p: Principal): Promise<GlSyncResult> {
  // the scheduler's system principal passes freely; a person pressing
  // "sync now" holds the capability
  if (p.kind === 'staff') await requireCapability(tx, p, 'gl.manage')
  const cfg = await glConfigInTx(tx)
  if (!cfg.enabled || !cfg.conversionDate) {
    return { configured: false, posted: 0, skipped: 0 }
  }
  const entries = await tx.query(
    `select e.id, e.entry_kind, e.signed_amount, e.effective_date, e.reverses,
            b.id as bill_id, b.bill_number, b.matter,
            rt.entry_kind as reversed_kind
       from deedbox.bill_journal_entry e
       join deedbox.bill b on b.id = e.bill and b.state = 'issued'
       left join deedbox.bill_journal_entry rt on rt.id = e.reverses
      where e.effective_date >= $1::date
        and not exists (
          select 1 from deedbox.gl_journal g
           where g.firm = $2 and g.source_ref = 'bje:' || e.id and g.status <> 'reversed')
      order by e.id`,
    [cfg.conversionDate, p.firm],
  )
  const ar = await purposeAccountInTx(tx, p.firm, 'accounts_receivable')
  let posted = 0
  let skipped = 0
  for (const e of entries.rows as Record<string, unknown>[]) {
    const kind = e.entry_kind as string
    const effectiveKind = kind === 'reversal' ? ((e.reversed_kind as string) ?? 'issue_total') : kind
    const counter = await purposeAccountInTx(tx, p.firm, counterPurpose(effectiveKind))
    const cents = toCents(e.signed_amount)
    const abs = Math.abs(cents)
    const arLine =
      cents > 0
        ? { account: ar, debitCents: abs, description: 'Accounts receivable', matter: e.matter as number }
        : { account: ar, creditCents: abs, description: 'Accounts receivable', matter: e.matter as number }
    const counterLine =
      cents > 0
        ? { account: counter, creditCents: abs, description: `Practice ${effectiveKind}` }
        : { account: counter, debitCents: abs, description: `Practice ${effectiveKind}` }
    const entryDate = toIsoDate(e.effective_date)
    const journalDate = entryDate < cfg.conversionDate ? cfg.conversionDate : entryDate
    // per-entry savepoint (the import engine's pattern): a refusal — a
    // locked period, a raced duplicate — rolls back ITS entry alone and the
    // sweep continues; the counts stay honest
    await tx.query(`savepoint gl_sync_entry`)
    try {
      await createPostedJournalInTx(tx, p, {
        journalDate,
        description: `Practice ${kind} on bill ${(e.bill_number as string) ?? e.bill_id}`,
        sourceType: bridgeSourceType(effectiveKind),
        sourceRef: `bje:${e.id}`,
        lines: [arLine, counterLine],
      })
      await tx.query(`release savepoint gl_sync_entry`)
      posted += 1
    } catch {
      await tx.query(`rollback to savepoint gl_sync_entry`)
      skipped += 1
    }
  }
  return { configured: true, posted, skipped }
}
