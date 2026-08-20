// Predicate-governed reads for the client-money screens. Read-only
// withPrincipal transactions; row security and the money capabilities do
// the gating. Figures of record are the schema's — running balances are
// ASSIGNED at the line guard, the certification equation is proven at
// certify — these reads only present them.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability, requireCapability, settingText, settingBool, firmRegional } from '@/lib/ops/shared'

function personNameText(v: unknown): string {
  const p = v as { given?: string; family?: string } | null
  if (!p) return ''
  return [p.given, p.family].filter(Boolean).join(' ')
}

const MONEY_CAPS = [
  'money.receive',
  'money.record_payment',
  'money.authorise_payment',
  'money.manage_accounts',
  'money.certify_reconciliation',
  'money.certify_close',
  'money.manage_earmarks',
  'money.manage_entitlements',
  'money.manage_dormancy',
  'money.manage_incidents',
  'money.issue_statements',
  'money.apply_held_funds',
]

async function requireAnyMoneyCap(tx: Tx, p: Principal): Promise<void> {
  for (const c of MONEY_CAPS) if (await hasCapability(tx, p.id, c)) return
  throw new OperationRefused('not_permitted', 'this screen needs a client-money capability')
}

// ---------------------------------------------------------------------------
// accounts overview
// ---------------------------------------------------------------------------

export async function accountsOverview(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAnyMoneyCap(tx, p)
      const accounts = await tx.query(
        `select a.id, a.name, a.account_kind, a.active,
                (select count(*)::int from deedbox.matter_ledger l where l.account = a.id) as ledgers,
                (select coalesce(sum(deedbox.ledger_balance(l.id)), 0)
                   from deedbox.matter_ledger l where l.account = a.id) as book_total,
                (select max(r.statement_date) from deedbox.reconciliation r
                  where r.account = a.id and r.status = 'certified') as last_certified,
                (select min(pc.due_by) from deedbox.period_close pc
                  where (pc.account = a.id or pc.scope = 'all_accounts') and pc.status = 'due') as next_close_due
           from deedbox.client_account a
          order by a.active desc, a.name`,
      )
      return accounts.rows
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// matter money tab (+ earmark panel + entitlement panel)
// ---------------------------------------------------------------------------

export async function matterMoneyTab(p: Principal, matterId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAnyMoneyCap(tx, p)
      const m = await tx.query(
        `select id, matter_number, title, status from deedbox.matter where id = $1`,
        [matterId],
      )
      if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
      const ledgers = await tx.query(
        `select l.id, l.ledger_number, l.status, l.account, a.name as account_name,
                deedbox.ledger_balance(l.id) as balance,
                coalesce((select sum(e.amount) from deedbox.earmark e
                           where e.matter_ledger = l.id and e.state = 'active'), 0) as earmarked
           from deedbox.matter_ledger l join deedbox.client_account a on a.id = l.account
          where l.matter = $1 order by l.id`,
        [matterId],
      )
      const ledgerIds = ledgers.rows.map((l) => l.id as number)
      const empty = { rows: [] as Record<string, unknown>[] }
      const earmarks = ledgerIds.length
        ? await tx.query(
            `select e.id, e.matter_ledger, e.amount, e.purpose, e.state, e.placed_at,
                    s.person_name as placed_by_name
               from deedbox.earmark e join deedbox.staff_member s on s.id = e.placed_by
              where e.matter_ledger = any($1)
              order by (e.state = 'active') desc, e.placed_at desc limit 50`,
            [ledgerIds],
          )
        : empty
      const entitlements = ledgerIds.length
        ? await tx.query(
            `select en.id, en.matter_ledger, en.amount, en.basis_kind, en.bill, en.pack_basis,
                    en.notice_required, en.notice_given_at, en.actionable_from, en.cancelled_at,
                    b.bill_number,
                    case
                      when en.cancelled_at is not null then 'cancelled'
                      when en.notice_required and en.notice_given_at is null then 'awaiting notice'
                      when en.actionable_from is not null and en.actionable_from > now() then 'notice running'
                      else 'actionable'
                    end as derived_status
               from deedbox.entitlement en
               left join deedbox.bill b on b.id = en.bill
              where en.matter_ledger = any($1)
              order by (en.cancelled_at is null) desc, en.id desc limit 50`,
            [ledgerIds],
          )
        : empty
      const recentLines = ledgerIds.length
        ? await tx.query(
            `select ll.id, ll.matter_ledger, ll.entry_no, ll.signed_amount, ll.running_balance,
                    t.txn_kind, t.effective_date, t.reason
               from deedbox.ledger_line ll join deedbox.money_transaction t on t.id = ll.transaction
              where ll.matter_ledger = any($1) and ll.side = 'matter_ledger'
              order by ll.matter_ledger, ll.entry_no desc limit 15`,
            [ledgerIds],
          )
        : empty
      const instruments = ledgerIds.length
        ? await tx.query(
            `select distinct i.id, i.direction, i.instrument_kind, i.number, i.amount, i.state,
                    i.stale_after
               from deedbox.instrument i
               join deedbox.ledger_line ll on ll.transaction = i.transaction
              where ll.matter_ledger = any($1)
                and i.state not in ('presented','replaced','cleared','dishonoured','cancelled')
              order by i.id desc`,
            [ledgerIds],
          )
        : empty
      const statements = ledgerIds.length
        ? await tx.query(
            `select id, matter_ledger, statement_number, period_start, period_end,
                    generated_at, issued_at, issue_channel
               from deedbox.client_money_statement
              where matter_ledger = any($1) order by id desc limit 20`,
            [ledgerIds],
          )
        : empty
      const dormant = ledgerIds.length
        ? await tx.query(
            `select id, matter_ledger, state, balance_at_detection, detected_at
               from deedbox.dormant_case
              where matter_ledger = any($1) and state in ('open','contact_in_progress')`,
            [ledgerIds],
          )
        : empty
      const accounts = await tx.query(
        `select id, name from deedbox.client_account where active order by name`,
      )
      return {
        matter: m.rows[0] as { id: number; matter_number: string; title: string; status: string },
        ledgers: ledgers.rows.map((l) => ({
          id: l.id as number,
          ledgerNumber: l.ledger_number as string,
          status: l.status as string,
          accountName: l.account_name as string,
          balance: Number(l.balance),
          earmarked: Number(l.earmarked),
          available: Number(l.balance) - Number(l.earmarked),
        })),
        earmarks: earmarks.rows,
        entitlements: entitlements.rows,
        recentLines: recentLines.rows,
        instruments: instruments.rows,
        statements: statements.rows,
        dormantCases: dormant.rows,
        accountOptions: accounts.rows as { id: number; name: string }[],
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// ledger screen
// ---------------------------------------------------------------------------

export async function ledgerScreen(p: Principal, ledgerId: number, opts: { before?: number } = {}) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAnyMoneyCap(tx, p)
      const l = await tx.query(
        `select l.id, l.ledger_number, l.status, l.ledger_kind, l.matter, l.account,
                a.name as account_name, m.matter_number, m.title,
                deedbox.ledger_balance(l.id) as balance
           from deedbox.matter_ledger l
           join deedbox.client_account a on a.id = l.account
           left join deedbox.matter m on m.id = l.matter
          where l.id = $1`,
        [ledgerId],
      )
      if (l.rowCount === 0) throw new OperationRefused('not_found', 'ledger not found')
      const lines = await tx.query(
        `select ll.id, ll.entry_no, ll.signed_amount, ll.running_balance,
                t.id as txn, t.txn_kind, t.effective_date, t.entered_at, t.reason,
                t.source_type, t.source, t.reverses,
                s.person_name as entered_by_name
           from deedbox.ledger_line ll
           join deedbox.money_transaction t on t.id = ll.transaction
           left join deedbox.staff_member s on s.id = t.entered_by
          where ll.matter_ledger = $1 and ll.side = 'matter_ledger'
            and ($2::int is null or ll.entry_no < $2)
          order by ll.entry_no desc limit 100`,
        [ledgerId, opts.before ?? null],
      )
      return { ledger: l.rows[0], lines: lines.rows }
    },
    { readOnly: true },
  )
}

/** The ledger as a document: the header and EVERY line in entry order —
 * the screen pages newest-first for reading; a printout must be complete
 * and chronological. Feeds the ledger PDF. */
export async function ledgerDocument(p: Principal, ledgerId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAnyMoneyCap(tx, p)
      const l = await tx.query(
        `select l.id, l.ledger_number, l.status, l.ledger_kind, l.matter, l.account,
                a.name as account_name, a.bank_identifiers, m.matter_number, m.title,
                coalesce((select cp.display_name from deedbox.party cp where cp.id = m.client_party), '') as client_name,
                (select f.name from deedbox.firm f order by f.id limit 1) as firm_name,
                deedbox.ledger_balance(l.id) as balance
           from deedbox.matter_ledger l
           join deedbox.client_account a on a.id = l.account
           left join deedbox.matter m on m.id = l.matter
          where l.id = $1`,
        [ledgerId],
      )
      if (l.rowCount === 0) throw new OperationRefused('not_found', 'ledger not found')
      const lines = await tx.query(
        `select ll.entry_no, ll.signed_amount, ll.running_balance,
                t.txn_kind, t.effective_date, t.reason, t.reverses
           from deedbox.ledger_line ll
           join deedbox.money_transaction t on t.id = ll.transaction
          where ll.matter_ledger = $1 and ll.side = 'matter_ledger'
          order by ll.entry_no`,
        [ledgerId],
      )
      return { ledger: l.rows[0], lines: lines.rows, regional: await firmRegional(tx, p.firm) }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// receipt form · payment workspace + authorisation queue + blocked
// ---------------------------------------------------------------------------

export async function receiptFormData(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'money.receive')
      const accounts = await tx.query(
        `select id, name, account_kind from deedbox.client_account where active order by name`,
      )
      const defaultAccount = await settingText(tx, 'money.default_client_account')
      // Method catalogue: the CALLER'S FIRM's active pack declaration, else
      // the neutral set. (Firm-scope every pack join — the shared world
      // holds many firms' packs.)
      const packMethods = await tx.query(
        `select d.body from deedbox.pack_declaration d
           join deedbox.firm f on f.id = $1
           join deedbox.country_pack cp on cp.id = f.country_pack
           join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
          where d.rule_point = 'money.payment_methods' limit 1`,
        [p.firm],
      )
      const methods =
        (packMethods.rows[0]?.body as { methods?: { key: string; instrument_backed?: boolean }[] })
          ?.methods ??
        [
          { key: 'electronic_transfer', instrument_backed: false },
          { key: 'card', instrument_backed: false },
          { key: 'cheque', instrument_backed: true },
          { key: 'cash', instrument_backed: false },
        ]
      return {
        accounts: accounts.rows as { id: number; name: string; account_kind: string }[],
        defaultAccount: defaultAccount ? Number(defaultAccount) : null,
        methods,
      }
    },
    { readOnly: true },
  )
}

export async function paymentWorkspace(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAnyMoneyCap(tx, p)
      const payments = await tx.query(
        `select mp.id, mp.state, mp.amount, mp.method, mp.reason, mp.purpose,
                mp.payment_number, mp.required_authorisations, mp.created_at,
                mp.matter_ledger, l.ledger_number, m.matter_number,
                pt.display_name as payee_name, mp.payee_description,
                rq.person_name as requester_name, mp.requested_by,
                (select count(*)::int from deedbox.payment_authorisation pa
                  where pa.subject_type in ('money_payment','firm_transfer','remittance')
                    and pa.subject = mp.id and pa.decision = 'approved') as approvals
           from deedbox.money_payment mp
           join deedbox.matter_ledger l on l.id = mp.matter_ledger
           left join deedbox.matter m on m.id = l.matter
           left join deedbox.party pt on pt.id = mp.payee_party
           join deedbox.staff_member rq on rq.id = mp.requested_by
          where mp.state in ('draft','pending_authorisation','authorised','blocked')
             or (mp.state = 'executed' and mp.executed_at > now() - interval '30 days')
          order by (mp.state = 'pending_authorisation') desc,
                   (mp.state = 'blocked') desc, mp.id desc
          limit 200`,
      )
      // The CALLER'S FIRM's active pack drives the payee capture's identifier
      // fields, exactly as it drives the firm's own payment-details capture
      // (firm-scope every pack join — the shared world holds many).
      const packFields = await tx.query(
        `select d.body from deedbox.pack_declaration d
           join deedbox.firm f on f.id = $1
           join deedbox.country_pack cp on cp.id = f.country_pack
           join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
          where d.rule_point = 'bank.account_identifiers' limit 1`,
        [p.firm],
      )
      return {
        drafts: payments.rows.filter((r) => r.state === 'draft'),
        pending: payments.rows.filter((r) => r.state === 'pending_authorisation'),
        authorised: payments.rows.filter((r) => r.state === 'authorised'),
        blocked: payments.rows.filter((r) => r.state === 'blocked'),
        recentExecuted: payments.rows.filter((r) => r.state === 'executed'),
        identifierSchema:
          (packFields.rows[0]?.body as { fields?: { key: string; label?: string }[] } | undefined) ?? null,
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// reconciliation workspace
// ---------------------------------------------------------------------------

export async function reconWorkspace(p: Principal, accountId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAnyMoneyCap(tx, p)
      const account = await tx.query(
        `select id, name from deedbox.client_account where id = $1`,
        [accountId],
      )
      if (account.rowCount === 0) throw new OperationRefused('not_found', 'account not found')
      const current = await tx.query(
        `select id, statement_date, statement_balance, status
           from deedbox.reconciliation
          where account = $1 and status = 'in_progress'
          order by id desc limit 1`,
        [accountId],
      )
      const recon = current.rows[0] ?? null

      const unmatchedLines = await tx.query(
        `select bl.id, bl.line_date, bl.amount, bl.description, bl.bank_ref
           from deedbox.bank_statement_line bl
          where bl.account = $1
            and not exists (select 1 from deedbox.recon_match_member mm
                             where mm.statement_line = bl.id)
          order by bl.line_date, bl.id limit 200`,
        [accountId],
      )
      const unmatchedTxns = await tx.query(
        `select t.id, t.txn_kind, t.effective_date, t.reason,
                ll.signed_amount, l.ledger_number
           from deedbox.ledger_line ll
           join deedbox.money_transaction t on t.id = ll.transaction
           left join deedbox.matter_ledger l on l.id = ll.matter_ledger
          where ll.account = $1 and ll.side = 'cash_book'
            and not exists (select 1 from deedbox.recon_match_member mm
                             where mm.transaction = t.id)
          order by t.effective_date, t.id limit 200`,
        [accountId],
      )
      const exceptions = recon
        ? await tx.query(
            `select e.id, e.exception_type, e.linked_type, e.linked, e.amount, e.arising_date,
                    e.state, (current_date - e.arising_date)::int as age_days
               from deedbox.recon_exception e
              where e.reconciliation = $1 and e.state in ('open','carried_forward')
              order by e.arising_date`,
            [recon.id],
          )
        : { rows: [] as Record<string, unknown>[] }
      const bookTotal = await tx.query(
        `select coalesce(sum(deedbox.ledger_balance(l.id)), 0) as total
           from deedbox.matter_ledger l where l.account = $1`,
        [accountId],
      )
      const staleDays = Number((await settingText(tx, 'money.stale_review_alert_days')) ?? 30)

      // The live equation, the same terms the schema proves at certify: statement +
      // unbanked receipts − unpresented payments ± bank errors = book total.
      let equation: null | {
        statementBalance: number
        unbanked: number
        unpresented: number
        bankErrors: number
        bookTotal: number
        remainder: number
      } = null
      if (recon) {
        const terms = exceptions.rows.reduce(
          (acc, e) => {
            const amt = Number(e.amount)
            if (e.exception_type === 'unbanked_receipt') acc.unbanked += amt
            else if (e.exception_type === 'unpresented_payment') acc.unpresented += amt
            else acc.bankErrors += amt
            return acc
          },
          { unbanked: 0, unpresented: 0, bankErrors: 0 },
        )
        const lhs =
          Number(recon.statement_balance) + terms.unbanked - terms.unpresented + terms.bankErrors
        equation = {
          statementBalance: Number(recon.statement_balance),
          ...terms,
          bookTotal: Number(bookTotal.rows[0].total),
          remainder: Number((lhs - Number(bookTotal.rows[0].total)).toFixed(2)),
        }
      }
      const history = await tx.query(
        `select id, statement_date, statement_balance, certified_at
           from deedbox.reconciliation
          where account = $1 and status = 'certified'
          order by statement_date desc limit 12`,
        [accountId],
      )
      return {
        account: account.rows[0] as { id: number; name: string },
        recon,
        unmatchedLines: unmatchedLines.rows,
        unmatchedTxns: unmatchedTxns.rows,
        exceptions: exceptions.rows,
        staleDays,
        equation,
        history: history.rows,
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// close board · instrument register
// ---------------------------------------------------------------------------

export async function closeBoard(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAnyMoneyCap(tx, p)
      const closes = await tx.query(
        `select pc.id, pc.scope, pc.account, pc.period_start, pc.period_end, pc.due_by,
                pc.status, pc.certified_at, pc.late, a.name as account_name
           from deedbox.period_close pc
           left join deedbox.client_account a on a.id = pc.account
          order by (pc.status = 'due') desc, (pc.status = 'in_progress') desc, pc.period_end desc
          limit 50`,
      )
      const accounts = await tx.query(
        `select id, name from deedbox.client_account where active order by name`,
      )
      return {
        closes: closes.rows,
        accounts: accounts.rows as { id: number; name: string }[],
      }
    },
    { readOnly: true },
  )
}

export async function closePreview(p: Principal, closeId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAnyMoneyCap(tx, p)
      const pc = await tx.query(
        `select pc.*, a.name as account_name from deedbox.period_close pc
           left join deedbox.client_account a on a.id = pc.account
          where pc.id = $1`,
        [closeId],
      )
      if (pc.rowCount === 0) throw new OperationRefused('not_found', 'close not found')
      const row = pc.rows[0]
      const ledgers = await tx.query(
        `select l.id, l.ledger_number, l.ledger_kind, deedbox.ledger_balance(l.id) as balance,
                m.matter_number
           from deedbox.matter_ledger l
           left join deedbox.matter m on m.id = l.matter
          where ($1::bigint is null or l.account = $1)
          order by l.ledger_number`,
        [row.account ?? null],
      )
      const certifiedListing =
        row.status === 'certified'
          ? await tx.query(
              `select bll.matter_ledger, bll.balance, l.ledger_number
                 from deedbox.balance_listing_line bll
                 join deedbox.matter_ledger l on l.id = bll.matter_ledger
                where bll.close = $1 order by bll.id`,
              [closeId],
            )
          : { rows: [] as Record<string, unknown>[] }
      return {
        close: row,
        liveLedgers: ledgers.rows,
        liveTotal: ledgers.rows.reduce((n, l) => n + Number(l.balance), 0),
        certifiedListing: certifiedListing.rows,
      }
    },
    { readOnly: true },
  )
}

export async function instrumentRegister(
  p: Principal,
  f: { direction?: string; state?: string } = {},
) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'money.manage_accounts')
      const r = await tx.query(
        `select i.id, i.direction, i.instrument_kind, i.number, i.amount, i.state,
                i.state_changed_at, i.stale_after, i.replaced_by, a.name as account_name,
                (current_date - i.stale_after)::int as days_past_stale
           from deedbox.instrument i join deedbox.client_account a on a.id = i.account
          where ($1::text is null or i.direction = $1)
            and ($2::text is null or i.state = $2)
          order by (i.state in ('created','received','banked','stale')) desc, i.id desc
          limit 300`,
        [f.direction ?? null, f.state ?? null],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// refusal register · incidents · dormancy
// ---------------------------------------------------------------------------

export async function refusalRegister(p: Principal, opts: { limit?: number } = {}) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const mayView =
        (await hasCapability(tx, p.id, 'register.read')) ||
        (await hasCapability(tx, p.id, 'money.manage_incidents'))
      if (!mayView) {
        throw new OperationRefused('not_permitted', 'the refusal register needs register.read or money.manage_incidents')
      }
      // The matter join rides the predicate: rows on invisible matters drop.
      const r = await tx.query(
        `select ro.id, ro.refusal_reason, ro.attempted_operation, ro.at,
                ro.attempted_by_kind, ro.attempted_by, ro.promoted_incident,
                a.name as account_name, l.ledger_number, m.matter_number,
                s.person_name as attempted_by_name
           from deedbox.refused_operation ro
           join deedbox.client_account a on a.id = ro.account
           left join deedbox.matter_ledger l on l.id = ro.matter_ledger
           left join deedbox.matter m on m.id = l.matter
           left join deedbox.staff_member s on s.id = ro.attempted_by and ro.attempted_by_kind = 'staff'
          where ro.matter_ledger is null or l.matter is null or m.id is not null
          order by ro.id desc limit $1`,
        [Math.min(opts.limit ?? 100, 500)],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function incidentRegister(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'money.manage_incidents')
      const r = await tx.query(
        `select di.id, di.incident_date, di.amount, di.cause, di.narrative, di.state,
                di.rectification, di.origin, di.notification_artefact,
                a.name as account_name, l.ledger_number
           from deedbox.deficiency_incident di
           join deedbox.client_account a on a.id = di.account
           left join deedbox.matter_ledger l on l.id = di.matter_ledger
          order by (di.state = 'open') desc, di.id desc limit 100`,
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function dormantQueue(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'money.manage_dormancy')
      const cases = await tx.query(
        `select dc.id, dc.state, dc.balance_at_detection, dc.detected_at,
                l.ledger_number, l.id as ledger, m.matter_number,
                deedbox.ledger_balance(l.id) as balance_now,
                (select count(*)::int from deedbox.contact_attempt ca where ca."case" = dc.id) as attempts,
                (select max(t.entered_at) from deedbox.ledger_line ll
                   join deedbox.money_transaction t on t.id = ll.transaction
                  where ll.matter_ledger = l.id) as last_movement
           from deedbox.dormant_case dc
           join deedbox.matter_ledger l on l.id = dc.matter_ledger
           left join deedbox.matter m on m.id = l.matter
          where dc.state in ('open','contact_in_progress')
          order by dc.detected_at`,
      )
      const attempts = await tx.query(
        `select ca."case", ca.channel, ca.evidence, ca.attempted_at
           from deedbox.contact_attempt ca
          where ca."case" = any($1) order by ca.attempted_at`,
        [cases.rows.map((c) => c.id as number)],
      )
      const remittances = await tx.query(
        `select rr.id, rr.authority, rr.amount, rr.remitted_date, rr.documentation,
                dc.matter_ledger, l.ledger_number
           from deedbox.remittance_register rr
           join deedbox.dormant_case dc on dc.id = rr."case"
           join deedbox.matter_ledger l on l.id = dc.matter_ledger
          order by rr.id desc limit 50`,
      )
      return { cases: cases.rows, attempts: attempts.rows, remittances: remittances.rows }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// statutory registers · statements screen
// ---------------------------------------------------------------------------

export async function statutoryRegistersScreen(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'money.manage_accounts')
      // Firm-scoped: only the caller's firm's active pack's registers.
      const registers = await tx.query(
        `select sr.id, sr.register_key, sr.name,
                (select count(*)::int from deedbox.statutory_register_entry e where e.register = sr.id) as entries
           from deedbox.statutory_register sr
           join deedbox.firm f on f.id = $1
           join deedbox.country_pack cp on cp.id = f.country_pack
           join deedbox.pack_version v on v.id = sr.pack_version and v.id = cp.active_version
          order by sr.register_key`,
        [p.firm],
      )
      const entries = await tx.query(
        `select e.register, e.entry_no, e.printable_artefact, e.created_at
           from deedbox.statutory_register_entry e
          where e.register = any($1)
          order by e.register, e.entry_no desc`,
        [registers.rows.map((r) => r.id as number)],
      )
      // Column schemas from the caller's firm's active pack declaration.
      const decl = await tx.query(
        `select d.body from deedbox.pack_declaration d
           join deedbox.firm f on f.id = $1
           join deedbox.country_pack cp on cp.id = f.country_pack
           join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
          where d.rule_point = 'registers.statutory' limit 1`,
        [p.firm],
      )
      return {
        registers: registers.rows,
        entries: entries.rows,
        declaration: decl.rows[0]?.body ?? null,
      }
    },
    { readOnly: true },
  )
}

export async function moneyStatementsScreen(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'money.issue_statements')
      const r = await tx.query(
        `select cms.id, cms.statement_number, cms.trigger_kind, cms.period_start, cms.period_end,
                cms.generated_at, cms.issued_at, cms.issue_channel,
                l.ledger_number, m.matter_number
           from deedbox.client_money_statement cms
           join deedbox.matter_ledger l on l.id = cms.matter_ledger
           left join deedbox.matter m on m.id = l.matter
          order by cms.id desc limit 100`,
      )
      return r.rows
    },
    { readOnly: true },
  )
}

/** Capability flags the money screens branch on (display convenience). */
export async function moneyViewerFlags(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => ({
      receive: await hasCapability(tx, p.id, 'money.receive'),
      recordPayment: await hasCapability(tx, p.id, 'money.record_payment'),
      authorise: await hasCapability(tx, p.id, 'money.authorise_payment'),
      manageAccounts: await hasCapability(tx, p.id, 'money.manage_accounts'),
      certifyRecon: await hasCapability(tx, p.id, 'money.certify_reconciliation'),
      certifyClose: await hasCapability(tx, p.id, 'money.certify_close'),
      earmarks: await hasCapability(tx, p.id, 'money.manage_earmarks'),
      entitlements: await hasCapability(tx, p.id, 'money.manage_entitlements'),
      dormancy: await hasCapability(tx, p.id, 'money.manage_dormancy'),
      incidents: await hasCapability(tx, p.id, 'money.manage_incidents'),
      statements: await hasCapability(tx, p.id, 'money.issue_statements'),
      // the screen shows Approve to a payment's own requester only when the
      // firm's setting allows self-authorisation — the rule the operation
      // itself enforces (0048); hiding the button despite the setting left
      // the approver-of-record unable to see how to approve
      selfAuthorisation: await settingBool(tx, 'money.self_authorisation'),
    }),
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Receipt and payment history — the find-a-transaction screens
// ---------------------------------------------------------------------------

export interface ReceiptHistoryRow {
  id: number
  receiptNumber: string
  receivedDate: string
  amount: number
  method: string
  payer: string
  matter: number
  matterNumber: string
  matterTitle: string
  /** The client party's best email — the Email action's suggested recipient. */
  clientEmail: string | null
}

/** Searchable receipt history: by payer, number, matter or words in the
 * matter's title, within an optional date range. Born from the first real
 * installation's second support email — the receipt screen recorded but
 * nothing listed. The viewer's matter predicate governs every row. */
export async function receiptHistory(
  p: Principal,
  f: { q?: string; from?: string; to?: string; limit?: number } = {},
): Promise<ReceiptHistoryRow[]> {
  requireStaff(p)
  const q = f.q?.trim() || null
  const limit = Math.min(f.limit ?? 100, 500)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select mr.id, mr.receipt_number, mr.received_date, mr.amount, mr.method,
                coalesce(pp.display_name, mr.payer_description, '—') as payer,
                m.id as matter, m.matter_number, m.title, ce.value as client_email
           from deedbox.money_receipt mr
           join deedbox.matter_ledger ml on ml.id = mr.matter_ledger
           join deedbox.matter m on m.id = ml.matter
           left join deedbox.party pp on pp.id = mr.payer_party
           left join lateral (
             select cp.value from deedbox.contact_point cp
              where cp.party = m.client_party and cp.kind = 'email'
                and cp.deleted_at is null
              order by cp.is_primary desc, cp.id limit 1
           ) ce on true
          where ($1::text is null
                 or mr.receipt_number ilike '%' || $1 || '%'
                 or coalesce(pp.display_name, '') ilike '%' || $1 || '%'
                 or coalesce(mr.payer_description, '') ilike '%' || $1 || '%'
                 or m.matter_number ilike '%' || $1 || '%'
                 or coalesce(m.prior_reference, '') ilike '%' || $1 || '%'
                 or m.title ilike '%' || $1 || '%')
            and ($2::date is null or mr.received_date >= $2)
            and ($3::date is null or mr.received_date <= $3)
          order by mr.received_date desc, mr.id desc
          limit $4`,
        [q, f.from || null, f.to || null, limit],
      )
      return r.rows.map((x) => ({
        id: x.id as number,
        receiptNumber: x.receipt_number as string,
        receivedDate: String(x.received_date),
        amount: Number(x.amount),
        method: x.method as string,
        payer: x.payer as string,
        matter: x.matter as number,
        matterNumber: x.matter_number as string,
        matterTitle: x.title as string,
        clientEmail: (x.client_email as string | null) ?? null,
      }))
    },
    { readOnly: true },
  )
}

export interface PaymentHistoryRow {
  id: number
  paymentNumber: string | null
  state: string
  amount: number
  method: string
  payee: string
  reason: string
  requestedAt: string
  executedAt: string | null
  matter: number
  matterNumber: string
  matterTitle: string
}

/** Searchable payment history across every state: by payee, number, reason,
 * matter or title, within an optional date range (against the executed date
 * where one exists, else the request date). */
export async function paymentHistory(
  p: Principal,
  f: { q?: string; from?: string; to?: string; limit?: number } = {},
): Promise<PaymentHistoryRow[]> {
  requireStaff(p)
  const q = f.q?.trim() || null
  const limit = Math.min(f.limit ?? 100, 500)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select mp.id, mp.payment_number, mp.state, mp.amount, mp.method, mp.reason,
                mp.created_at, mp.executed_at,
                coalesce(pp.display_name, mp.payee_description, '—') as payee,
                m.id as matter, m.matter_number, m.title
           from deedbox.money_payment mp
           join deedbox.matter_ledger ml on ml.id = mp.matter_ledger
           join deedbox.matter m on m.id = ml.matter
           left join deedbox.party pp on pp.id = mp.payee_party
          where ($1::text is null
                 or coalesce(mp.payment_number, '') ilike '%' || $1 || '%'
                 or coalesce(pp.display_name, '') ilike '%' || $1 || '%'
                 or coalesce(mp.payee_description, '') ilike '%' || $1 || '%'
                 or mp.reason ilike '%' || $1 || '%'
                 or m.matter_number ilike '%' || $1 || '%'
                 or coalesce(m.prior_reference, '') ilike '%' || $1 || '%'
                 or m.title ilike '%' || $1 || '%')
            and ($2::date is null or coalesce(mp.executed_at::date, mp.created_at::date) >= $2)
            and ($3::date is null or coalesce(mp.executed_at::date, mp.created_at::date) <= $3)
          order by mp.id desc
          limit $4`,
        [q, f.from || null, f.to || null, limit],
      )
      return r.rows.map((x) => ({
        id: x.id as number,
        paymentNumber: (x.payment_number as string) ?? null,
        state: x.state as string,
        amount: Number(x.amount),
        method: x.method as string,
        payee: x.payee as string,
        reason: x.reason as string,
        requestedAt: String(x.created_at),
        executedAt: x.executed_at ? String(x.executed_at) : null,
        matter: x.matter as number,
        matterNumber: x.matter_number as string,
        matterTitle: x.title as string,
      }))
    },
    { readOnly: true },
  )
}

// ---- the payment form's ledger finder, and the requisition (0050) --------------

export interface LedgerMatch {
  id: number
  ledgerNumber: string
  status: string
  accountName: string
  matter: number
  matterNumber: string
  matterTitle: string
  clientName: string
  balance: number
  earmarked: number
  available: number
}

/**
 * Find a client ledger by the numbers a person actually knows — the ledger
 * number, the matter number, or the matter's prior-system reference — with
 * its balance, what is earmarked, and what is available to pay away. Exact
 * matches first; more than one row means the matter holds several ledgers
 * (or the text matched several matters) and the person chooses.
 */
export async function findLedgers(p: Principal, q: string): Promise<LedgerMatch[]> {
  requireStaff(p)
  const needle = q.trim()
  if (!needle) return []
  return withPrincipal(
    p,
    async (tx) => {
      await requireAnyMoneyCap(tx, p)
      const r = await tx.query(
        `select l.id, l.ledger_number, l.status, a.name as account_name,
                m.id as matter, m.matter_number, m.title,
                coalesce((select cp.display_name from deedbox.party cp where cp.id = m.client_party), '') as client_name,
                deedbox.ledger_balance(l.id) as balance,
                coalesce((select sum(e.amount) from deedbox.earmark e
                           where e.matter_ledger = l.id and e.state = 'active'), 0) as earmarked,
                (l.ledger_number = $1 or m.matter_number = $1 or m.prior_reference = $1) as exact
           from deedbox.matter_ledger l
           join deedbox.client_account a on a.id = l.account
           join deedbox.matter m on m.id = l.matter
          where l.ledger_kind = 'client_matter'
            and (l.ledger_number = $1 or m.matter_number = $1 or m.prior_reference = $1
                 or l.ledger_number ilike '%' || $1 || '%' or m.matter_number ilike '%' || $1 || '%'
                 or coalesce(m.prior_reference, '') ilike '%' || $1 || '%'
                 or exists (select 1 from deedbox.party cn
                             where cn.id = m.client_party
                               and cn.display_name ilike '%' || $1 || '%'))
          order by exact desc, (l.status = 'open') desc, l.ledger_number
          limit 12`,
        [needle],
      )
      return r.rows.map((x) => ({
        id: x.id as number,
        ledgerNumber: x.ledger_number as string,
        status: x.status as string,
        accountName: x.account_name as string,
        matter: x.matter as number,
        matterNumber: x.matter_number as string,
        matterTitle: x.title as string,
        clientName: x.client_name as string,
        balance: Number(x.balance),
        earmarked: Number(x.earmarked),
        available: Number(x.balance) - Number(x.earmarked),
      }))
    },
    { readOnly: true },
  )
}

/** Everything the printed requisition for one payment says. */
export async function paymentRequisition(p: Principal, paymentId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAnyMoneyCap(tx, p)
      const r = await tx.query(
        `select mp.id, mp.state, mp.payment_number, mp.amount, mp.method, mp.reason, mp.purpose,
                mp.payee_description, mp.payee_bank_details, mp.external_reference,
                mp.created_at, mp.submitted_at, mp.decided_at, mp.executed_at,
                pp.display_name as payee_name,
                l.ledger_number, a.name as account_name, a.bank_identifiers as account_bank_identifiers,
                case when mp.purpose = 'firm_transfer' then
                  (select jsonb_build_object('account holder', gpd.account_holder_name, 'bank', gpd.bank_name) || gpd.identifier_values
                     from deedbox.governing_payment_details() gpd where gpd.id is not null)
                end as firm_payee_details,
                m.matter_number, m.title as matter_title, m.prior_reference,
                coalesce((select cp.display_name from deedbox.party cp where cp.id = m.client_party), '') as client_name,
                rq.person_name as requester_name,
                (select f.name from deedbox.firm f order by f.id limit 1) as firm_name,
                deedbox.ledger_balance(l.id) as ledger_balance
           from deedbox.money_payment mp
           join deedbox.matter_ledger l on l.id = mp.matter_ledger
           join deedbox.client_account a on a.id = l.account
           join deedbox.matter m on m.id = l.matter
           join deedbox.staff_member rq on rq.id = mp.requested_by
           left join deedbox.party pp on pp.id = mp.payee_party
          where mp.id = $1`,
        [paymentId],
      )
      if (r.rowCount === 0) throw new OperationRefused('not_found', 'payment not found')
      const auths = await tx.query(
        `select pa.decision, pa.at as decided_at, s.person_name
           from deedbox.payment_authorisation pa
           join deedbox.staff_member s on s.id = pa.authoriser
          where pa.subject_type = 'money_payment' and pa.subject = $1
          order by pa.at`,
        [paymentId],
      )
      return {
        payment: r.rows[0] as Record<string, unknown>,
        authorisations: auths.rows as Record<string, unknown>[],
        regional: await firmRegional(tx, p.firm),
      }
    },
    { readOnly: true },
  )
}
