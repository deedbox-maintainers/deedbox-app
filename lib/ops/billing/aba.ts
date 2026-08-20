// The Australian direct-entry (ABA) bank file for a completed held-funds
// application run: ONE lump credit to the firm's working account (the
// governing payment-details record), traced from the firm's client account
// (its recorded bank identifiers, 0052) — the file the person keys into the
// bank so the transfer they authorised in the app is the transfer the bank
// makes. A pure read over completed items; no money machinery is touched.
//
// Format: APCA 120-character records — one descriptive (0), one detail (1,
// transaction code 50 credit), one total (7). Credit-only file; the user
// identification number is the firm's APCA id when it holds one (setting
// billing.apca_user_id; '000000' until then, which several banks accept for
// self-service files — verify with the bank on first use).

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability, settingText } from '@/lib/ops/shared'

/**
 * Whether this jurisdiction's bank file can render at all: the active pack
 * must declare bank.account_identifiers with a BSB field — the shape this
 * renderer needs on both sides of the transfer. The engine's rule-point
 * catalogue has no payment-file point yet (a recorded layer-audit
 * finding); until one exists, this gate keeps the Australian renderer
 * invisible on every installation whose pack does not describe Australian
 * accounts. The route and the run screen both consult it.
 */
export async function bankFileAvailable(tx: Tx, firm: number): Promise<boolean> {
  const r = await tx.query(
    `select 1 from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
      where d.pack_version = cp.active_version
        and d.rule_point = 'bank.account_identifiers'
        and d.body->'fields' @> '[{"key":"bsb"}]'`,
    [firm],
  )
  return r.rowCount! > 0
}

/** The gate as a principal-level read, for screens and routes. */
export async function bankFileAvailableFor(p: Principal): Promise<boolean> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => bankFileAvailable(tx, p.firm), { readOnly: true })
}

function fixed(s: string, width: number, right = false, fill = ' '): string {
  const t = (s ?? '').slice(0, width)
  return right ? t.padStart(width, fill) : t.padEnd(width, fill)
}

function digits(s: string): string {
  return (s ?? '').replace(/\D/g, '')
}

function bsb(s: string): string {
  const d = digits(s)
  if (d.length !== 6) throw new OperationRefused('bank_details_missing', `a BSB needs six digits — found "${s}"`)
  return `${d.slice(0, 3)}-${d.slice(3)}`
}

function findIdentifier(values: Record<string, string>, pattern: RegExp): string | null {
  for (const [k, v] of Object.entries(values ?? {})) {
    if (pattern.test(k) && String(v).trim()) return String(v).trim()
  }
  return null
}

export async function heldFundsRunAba(
  p: Principal,
  input: { run: number },
): Promise<{ filename: string; content: string; total: number; items: number }> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'money.apply_held_funds')
      if (!(await bankFileAvailable(tx, p.firm))) {
        throw new OperationRefused(
          'bank_file_unavailable',
          "this installation's country pack declares no BSB-shaped bank identifiers — the bank file is an Australian format",
        )
      }
      const run = await tx.query(
        `select ar.id, ar.run_at::date::text as run_date from deedbox.application_run ar where ar.id = $1`,
        [input.run],
      )
      if (run.rowCount === 0) throw new OperationRefused('not_found', 'application run not found')
      const items = await tx.query(
        `select count(*)::int as n, coalesce(sum(amount), 0) as total
           from deedbox.funds_application where run = $1 and item_state = 'completed'`,
        [input.run],
      )
      const count = items.rows[0].n as number
      const total = Number(items.rows[0].total)
      if (count === 0 || !(total > 0)) {
        throw new OperationRefused('nothing_completed', 'no completed transfers on this run — the bank file renders once transfers execute')
      }

      // credit side: the firm's working account, from the governing
      // payment-details record — taken verbatim, never assembled
      const pd = await tx.query(
        `select account_holder_name, bank_name, identifier_values
           from deedbox.payment_details
          where state = 'approved' order by id desc limit 1`,
      )
      if (pd.rowCount === 0) {
        throw new OperationRefused('bank_details_missing', 'no governing payment details — record the firm working account on Billing › Payment details first')
      }
      const office = pd.rows[0]
      const officeIds = (office.identifier_values ?? {}) as Record<string, string>
      const officeBsb = findIdentifier(officeIds, /bsb|branch/i)
      const officeAcct = findIdentifier(officeIds, /acc/i)
      if (!officeBsb || !officeAcct) {
        throw new OperationRefused('bank_details_missing', 'the governing payment details carry no BSB/account identifiers')
      }

      // trace side: THE client account the run's completed transfers actually
      // drew from — derived from the items themselves, never assumed. A run
      // spanning accounts would need one file per account; refuse honestly.
      const ca = await tx.query(
        `select distinct ca.id, ca.name, ca.bank_identifiers
           from deedbox.funds_application fa
           join deedbox.matter_ledger ml on ml.id = fa.matter_ledger
           join deedbox.client_account ca on ca.id = ml.account
          where fa.run = $1 and fa.item_state = 'completed'`,
        [input.run],
      )
      if (ca.rowCount! > 1) {
        throw new OperationRefused(
          'mixed_accounts',
          'the completed transfers drew from more than one client account — a bank file covers one account',
        )
      }
      const trust = ca.rows[0] ?? null
      const trustIds = (trust?.bank_identifiers ?? null) as Record<string, string> | null
      const trustBsb = trustIds ? findIdentifier(trustIds, /bsb|branch/i) : null
      const trustAcct = trustIds ? findIdentifier(trustIds, /acc/i) : null
      if (!trustBsb || !trustAcct) {
        throw new OperationRefused('bank_details_missing', "the client account's bank identifiers are not recorded — the trace side of the file needs them")
      }

      const userId = ((await settingText(tx, 'billing.apca_user_id')) ?? '000000').replace(/\D/g, '').padStart(6, '0').slice(-6)
      const d = new Date(`${run.rows[0].run_date}T00:00:00Z`)
      const ddmmyy = `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCFullYear()).slice(-2)}`
      const cents = Math.round(total * 100)
      const bankAbbrev = fixed(String(office.bank_name ?? '').toUpperCase().replace(/[^A-Z]/g, ''), 3)

      const rec0 =
        '0' + fixed('', 17) + '01' + bankAbbrev + fixed('', 7) +
        fixed(String(office.account_holder_name ?? '').toUpperCase(), 26) +
        userId + fixed('TRUST TRNSFR', 12) + ddmmyy + fixed('', 40)
      const rec1 =
        '1' + bsb(officeBsb) + fixed(digits(officeAcct), 9, true) + ' ' + '50' +
        fixed(String(cents), 10, true, '0') +
        fixed(String(office.account_holder_name ?? '').toUpperCase(), 32) +
        fixed(`RUN ${input.run}`, 18) +
        bsb(trustBsb) + fixed(digits(trustAcct), 9, true) +
        fixed(String(trust?.name ?? '').toUpperCase(), 16) + '00000000'
      const rec7 =
        '7' + '999-999' + fixed('', 12) +
        fixed(String(cents), 10, true, '0') + fixed(String(cents), 10, true, '0') +
        fixed('0', 10, true, '0') + fixed('', 24) + fixed('1', 6, true, '0') + fixed('', 40)

      for (const [i, r] of [rec0, rec1, rec7].entries()) {
        if (r.length !== 120) {
          throw new OperationRefused('render_failed', `bank file record ${i} is ${r.length} characters — must be 120`)
        }
      }
      return {
        filename: `trust-transfer-run-${input.run}.aba`,
        content: `${rec0}\r\n${rec1}\r\n${rec7}\r\n`,
        total,
        items: count,
      }
    },
    { readOnly: true },
  )
}
