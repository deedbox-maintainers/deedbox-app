// Predicate-governed reads for the billing screens (eighteen surfaces + the
// payment-details capture screen). Read-only withPrincipal transactions;
// the visibility predicate does the hiding — a figure and its drill-down
// can never disagree. Cost rates are row-secured on see_cost_rates: the
// read simply returns nothing without it.

import type { Principal } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability, requireCapability, settingText, settingBool, taxTreatments, firmRegional, type TaxTreatment } from '@/lib/ops/shared'

function personNameText(v: unknown): string {
  const p = v as { given?: string; family?: string } | null
  if (!p) return ''
  return [p.given, p.family].filter(Boolean).join(' ')
}

const AGE_BAND_SQL = `case
  when age_days <= 30 then '0–30'
  when age_days <= 60 then '31–60'
  when age_days <= 90 then '61–90'
  when age_days <= 180 then '91–180'
  else '180+' end`

// ---------------------------------------------------------------------------
// my time · timers · suggestion queue
// ---------------------------------------------------------------------------

export async function myTime(p: Principal, opts: { from: string; to: string }) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const entries = await tx.query(
        `select te.id, te.work_date, te.kind, te.units, te.value, te.narrative,
                te.billed_state, ci.label as category, ci.counts_as_chargeable,
                m.id as matter, m.matter_number, m.title
           from deedbox.time_entry te
           join deedbox.choice_item ci on ci.id = te.category
           join deedbox.matter m on m.id = te.matter
          where te.staff = $1 and te.deleted_at is null
            and te.work_date between $2::date and $3::date
          order by te.work_date desc, te.id desc`,
        [p.id, opts.from, opts.to],
      )
      const totals = await tx.query(
        `select ci.label as category, ci.counts_as_chargeable,
                sum(te.value)::numeric(14,2) as value, count(*)::int as entries
           from deedbox.time_entry te join deedbox.choice_item ci on ci.id = te.category
          where te.staff = $1 and te.deleted_at is null
            and te.work_date between $2::date and $3::date
          group by ci.label, ci.counts_as_chargeable order by ci.label`,
        [p.id, opts.from, opts.to],
      )
      const categories = await tx.query(
        `select ci.id, ci.label from deedbox.choice_item ci
           join deedbox.choice_list cl on cl.id = ci.list
          where cl.purpose_key = 'time_categories' and ci.active order by ci.position`,
      )
      return {
        entries: entries.rows,
        totals: totals.rows,
        categories: categories.rows as { id: number; label: string }[],
      }
    },
    { readOnly: true },
  )
}

export async function myTimers(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select t.id, t.matter, t.state, t.started_at, t.accumulated_seconds, t.narrative_draft,
                m.matter_number, m.title
           from deedbox.timer t left join deedbox.matter m on m.id = t.matter
          where t.staff = $1 and t.state in ('running','paused')
          order by t.started_at`,
        [p.id],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function suggestionQueue(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select se.id, se.state, se.proposed_date, se.proposed_minutes, se.proposed_narrative,
                se.matter, m.matter_number, m.title,
                sg.source_module as signal_source, sg.signal_kind, sg.occurred_at as signal_at
           from deedbox.suggested_entry se
           join deedbox.activity_signal sg on sg.id = se.signal
           left join deedbox.matter m on m.id = se.matter
          where se.staff = $1 and se.state in ('pending','held_unmatched')
          order by se.proposed_date, se.id`,
        [p.id],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// matter WIP + estimate & budget panel
// ---------------------------------------------------------------------------

export async function matterWip(p: Principal, matterId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const m = await tx.query(
        `select id, matter_number, title, status, billing_hold from deedbox.matter where id = $1`,
        [matterId],
      )
      if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
      const time = await tx.query(
        `select x.*, ${AGE_BAND_SQL} as age_band from (
           select te.id, te.work_date, te.units, te.value, te.narrative, te.billed_state,
                  s.person_name as staff_name, ci.label as category,
                  (current_date - te.work_date)::int as age_days
             from deedbox.time_entry te
             join deedbox.staff_member s on s.id = te.staff
             join deedbox.choice_item ci on ci.id = te.category
            where te.matter = $1 and te.billed_state = 'unbilled' and te.deleted_at is null
         ) x order by x.work_date`,
        [matterId],
      )
      const disb = await tx.query(
        `select x.*, ${AGE_BAND_SQL} as age_band from (
           select d.id, d.incurred_date, d.amount, d.description, d.billed_state,
                  (current_date - d.incurred_date)::int as age_days
             from deedbox.disbursement d
            where d.matter = $1 and d.billed_state = 'unbilled' and d.deleted_at is null
         ) x order by x.incurred_date`,
        [matterId],
      )
      const estimate = await tx.query(
        `select e.id, e.current_amount, e.alert_thresholds,
                coalesce((select jsonb_agg(jsonb_build_object(
                    'revisionNo', r.revision_no, 'amount', r.amount, 'revisedAt', r.revised_at,
                    'author', (select s.person_name #>> '{family}' from deedbox.staff_member s where s.id = r.author),
                    'reason', r.reason) order by r.revision_no desc)
                  from deedbox.estimate_revision r where r.estimate = e.id), '[]'::jsonb) as revisions
           from deedbox.cost_estimate e where e.matter = $1`,
        [matterId],
      )
      // Display-only consumption: recorded-but-unbilled plus billed totals.
      // Figures of record live in the threshold evaluation and the journals.
      const consumption = await tx.query(
        `select
           coalesce((select sum(value) from deedbox.time_entry
                      where matter = $1 and billed_state = 'unbilled' and deleted_at is null), 0)
         + coalesce((select sum(amount) from deedbox.disbursement
                      where matter = $1 and billed_state = 'unbilled' and deleted_at is null), 0) as unbilled,
           coalesce((select sum(j.signed_amount) from deedbox.bill_journal_entry j
                      join deedbox.bill b on b.id = j.bill
                     where b.matter = $1 and j.entry_kind in ('issue_total','interest_charge')), 0) as billed`,
        [matterId],
      )
      const budgets = await tx.query(
        `select b.id, b.level, b.stage, b.amount, b.thresholds, b.active,
                coalesce((select sum(te.value) from deedbox.time_entry te
                           where te.matter = b.matter and te.deleted_at is null
                             and te.billed_state <> 'written_off_before_billing'), 0)
              + coalesce((select sum(d.amount) from deedbox.disbursement d
                           where d.matter = b.matter and d.deleted_at is null
                             and d.billed_state <> 'written_off_before_billing'), 0) as spend
           from deedbox.budget b where b.matter = $1 and b.active order by b.id`,
        [matterId],
      )
      // Alerts join through their subjects — the alert row carries no matter.
      const alerts = await tx.query(
        `select a.id, a.subject_type, a.threshold_pct, a.fired_at
           from deedbox.threshold_alert a
          where (a.subject_type = 'estimate' and a.subject in (select id from deedbox.cost_estimate where matter = $1))
             or (a.subject_type = 'budget' and a.subject in (select id from deedbox.budget where matter = $1))
             or (a.subject_type = 'funds_policy' and a.subject in (select id from deedbox.matter_funds_policy where matter = $1))
          order by a.fired_at desc limit 20`,
        [matterId],
      )
      const holds = await tx.query(
        `select h.id, h.reason, h.placed_at, h.released_at,
                s.person_name as placed_by_name
           from deedbox.billing_hold h join deedbox.staff_member s on s.id = h.placed_by
          where h.matter = $1 order by h.placed_at desc`,
        [matterId],
      )
      const drafts = await tx.query(
        `select g.id, g.state, g.matter_total, g.created_at,
                (select count(*)::int from deedbox.bill b where b.bill_group = g.id) as siblings,
                (select min(b.state) from deedbox.bill b where b.bill_group = g.id) as bill_state
           from deedbox.bill_group g
          where g.matter = $1 and g.state = 'draft' order by g.id desc`,
        [matterId],
      )
      const fundsPolicy = await tx.query(
        `select id, minimum_threshold, target_amount, attach_to_next_bill, auto_issue
           from deedbox.matter_funds_policy where matter = $1`,
        [matterId],
      )
      const payers = await tx.query(
        `select mp.id, mp.payer_party, mp.share_pct, pt.display_name
           from deedbox.matter_payer mp join deedbox.party pt on pt.id = mp.payer_party
          where mp.matter = $1 and mp.active order by mp.id`,
        [matterId],
      )
      return {
        matter: m.rows[0] as {
          id: number
          matter_number: string
          title: string
          status: string
          billing_hold: boolean
        },
        time: time.rows,
        disbursements: disb.rows,
        estimate: estimate.rows[0] ?? null,
        consumption: {
          unbilled: Number(consumption.rows[0].unbilled),
          billed: Number(consumption.rows[0].billed),
        },
        budgets: budgets.rows,
        alerts: alerts.rows,
        holds: holds.rows,
        openHold: holds.rows.find((h) => h.released_at === null) ?? null,
        drafts: drafts.rows,
        fundsPolicy: fundsPolicy.rows[0] ?? null,
        payers: payers.rows,
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// draft editor · approval queue
// ---------------------------------------------------------------------------

/** The firm-wide held-funds scope: every matter holding an uncancelled
 * entitlement on an open ledger — the same universe the run itself derives
 * candidates from, resolved to an EXPLICIT matter list so a firm-wide
 * preview is recorded as the cross-matter run it is. */
export async function heldFundsFirmScope(p: Principal): Promise<number[]> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      // the matter join is load-bearing: it puts the viewer's visibility
      // walls (office/assignment scopes, restricted matters) between them
      // and the sweep — a blank preview must not name matters its author
      // could not open
      const r = await tx.query(
        `select distinct ml.matter
           from deedbox.entitlement e
           join deedbox.matter_ledger ml on ml.id = e.matter_ledger
           join deedbox.matter m on m.id = ml.matter
          where ml.status = 'open' and e.cancelled_at is null
          order by ml.matter`,
      )
      return r.rows.map((x) => x.matter as number)
    },
    { readOnly: true },
  )
}

/** The matter's issued bills — the finding side of the billing tab: every
 * bill that reached issue, with its live outstanding from the journal. */
export async function matterBills(p: Principal, matterId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select b.id, b.bill_number, b.state, b.issue_date, b.due_date,
                pt.display_name as payer_name,
                coalesce((select j.signed_amount from deedbox.bill_journal_entry j
                           where j.bill = b.id and j.entry_kind = 'issue_total'
                           order by j.entry_no limit 1), 0) as issue_total,
                deedbox.bill_outstanding(b.id) as outstanding
           from deedbox.bill b
           join deedbox.party pt on pt.id = b.payer_party
          where b.matter = $1 and b.state = 'issued'
          order by b.issue_date desc, b.id desc`,
        [matterId],
      )
      return r.rows.map((x) => ({
        id: x.id as number,
        billNumber: x.bill_number as string | null,
        issueDate: x.issue_date as string | null,
        dueDate: x.due_date as string | null,
        payerName: x.payer_name as string,
        issueTotal: Number(x.issue_total),
        outstanding: Number(x.outstanding),
      }))
    },
    { readOnly: true },
  )
}

export async function draftEditor(p: Principal, groupId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const g = await tx.query(
        `select g.id, g.matter, g.state, g.matter_total, g.payer_share_snapshot, g.rounding_record,
                m.matter_number, m.title, m.billing_hold
           from deedbox.bill_group g join deedbox.matter m on m.id = g.matter
          where g.id = $1`,
        [groupId],
      )
      if (g.rowCount === 0) throw new OperationRefused('not_found', 'draft group not found')
      const bills = await tx.query(
        `select b.id, b.payer_party, b.share_pct, b.state, b.submitted_at,
                s.person_name as submitted_by_name, pt.display_name as payer_name,
                coalesce((select sum(l.amount + l.tax_amount) from deedbox.bill_line l where l.bill = b.id), 0) as total
           from deedbox.bill b
           join deedbox.party pt on pt.id = b.payer_party
           left join deedbox.staff_member s on s.id = b.submitted_by
          where b.bill_group = $1 order by b.id`,
        [groupId],
      )
      const lines = await tx.query(
        `select l.id, l.bill, l.position, l.kind, l.description, l.quantity_units, l.rate,
                l.original_value, l.written_down_to, l.write_down_reason, l.amount,
                l.tax_treatment, l.tax_amount, l.category_key
           from deedbox.bill_line l
          where l.bill in (select id from deedbox.bill where bill_group = $1)
          order by l.bill, l.position`,
        [groupId],
      )
      const approvalRequired = await settingBool(tx, 'bill.approval_required')
      const mayIssue = await hasCapability(tx, p.id, 'bill.issue')
      const mayApprove = await hasCapability(tx, p.id, 'bill.approve')
      const openHold = await tx.query(
        `select h.id, h.reason from deedbox.billing_hold h
          where h.matter = $1 and h.released_at is null limit 1`,
        [g.rows[0].matter],
      )
      return {
        group: g.rows[0],
        bills: bills.rows,
        lines: lines.rows,
        approvalRequired,
        mayIssue,
        mayApprove,
        openHold: openHold.rows[0] ?? null,
      }
    },
    { readOnly: true },
  )
}

export async function billApprovalQueue(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'bill.approve')
      const r = await tx.query(
        `select g.id as group_id, g.matter, g.matter_total, m.matter_number, m.title,
                min(b.submitted_at) as submitted_at,
                (select s.person_name from deedbox.staff_member s
                  where s.id = min(b.submitted_by)) as submitter_name,
                count(*)::int as siblings
           from deedbox.bill_group g
           join deedbox.bill b on b.bill_group = g.id
           join deedbox.matter m on m.id = g.matter
          where b.state = 'pending_approval' and g.state = 'draft'
          group by g.id, g.matter, g.matter_total, m.matter_number, m.title
          order by min(b.submitted_at)`,
      )
      return r.rows
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// billing runs
// ---------------------------------------------------------------------------

export async function billingRuns(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select br.id, br.run_at, br.state, br.filter_snapshot,
                s.person_name as run_by_name,
                (select count(*)::int from deedbox.bill_group g where g.billing_run = br.id) as groups
           from deedbox.billing_run br join deedbox.staff_member s on s.id = br.run_by
          order by br.id desc limit 50`,
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function billingRunDetail(p: Principal, runId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const run = await tx.query(
        `select br.id, br.run_at, br.state, br.filter_snapshot, s.person_name as run_by_name
           from deedbox.billing_run br join deedbox.staff_member s on s.id = br.run_by
          where br.id = $1`,
        [runId],
      )
      if (run.rowCount === 0) throw new OperationRefused('not_found', 'billing run not found')
      const groups = await tx.query(
        `select g.id, g.matter, g.state, g.matter_total, m.matter_number, m.title,
                coalesce((select cp.display_name from deedbox.party cp where cp.id = m.client_party), '') as client_name,
                coalesce((select sum(deedbox.ledger_available(l.id))
                            from deedbox.matter_ledger l
                           where l.matter = m.id and l.ledger_kind = 'client_matter' and l.status = 'open'), 0) as held_available,
                (select count(*)::int from deedbox.bill b where b.bill_group = g.id) as siblings
           from deedbox.bill_group g join deedbox.matter m on m.id = g.matter
          where g.billing_run = $1 order by g.id`,
        [runId],
      )
      // the run's issued bills still owed, with the held money that could pay
      // them — the "pay from held client money" panel's rows
      const payable = await tx.query(
        `select b.id as bill, b.bill_number, b.matter, m.matter_number,
                coalesce((select cp.display_name from deedbox.party cp where cp.id = m.client_party), '') as client_name,
                deedbox.bill_outstanding(b.id) as outstanding,
                coalesce((select sum(deedbox.ledger_available(l.id))
                            from deedbox.matter_ledger l
                           where l.matter = b.matter and l.ledger_kind = 'client_matter' and l.status = 'open'), 0) as held_available
           from deedbox.bill b
           join deedbox.bill_group g on g.id = b.bill_group
           join deedbox.matter m on m.id = b.matter
          where g.billing_run = $1 and b.state = 'issued'
            and deedbox.bill_outstanding(b.id) > 0
          order by b.id`,
        [runId],
      )
      return { run: run.rows[0], groups: groups.rows, payable: payable.rows }
    },
    { readOnly: true },
  )
}

/**
 * The run builder's preview: every candidate matter the filters reach, with
 * the figures the person chooses BY — the client's name, unbilled work at the
 * cut-off, held client money available — and the exclusions the run would
 * record (hold, closed), honestly, before anything drafts. Selection then
 * feeds createBillingRun's explicit matter list.
 */
export async function billingRunCandidates(
  p: Principal,
  filters: { practiceArea?: number; office?: number; responsibleLawyer?: number; throughDate?: string },
) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select m.id, m.matter_number, m.title, m.status, m.billing_hold,
                coalesce((select cp.display_name from deedbox.party cp where cp.id = m.client_party), '') as client_name,
                coalesce((select sum(te.value) from deedbox.time_entry te
                           where te.matter = m.id and te.billed_state = 'unbilled' and te.deleted_at is null
                             and ($4::date is null or te.work_date <= $4)), 0)
              + coalesce((select sum(d.amount) from deedbox.disbursement d
                           where d.matter = m.id and d.billed_state = 'unbilled' and d.billable and d.deleted_at is null
                             and ($4::date is null or d.incurred_date <= $4)), 0) as unbilled_value,
                coalesce((select sum(deedbox.ledger_available(l.id))
                            from deedbox.matter_ledger l
                           where l.matter = m.id and l.ledger_kind = 'client_matter' and l.status = 'open'), 0) as held_available
           from deedbox.matter m
          where ($1::bigint is null or m.practice_area = $1)
            and ($2::bigint is null or m.office = $2)
            and ($3::bigint is null or m.responsible_lawyer = $3)
            and (exists (select 1 from deedbox.time_entry te
                          where te.matter = m.id and te.billed_state = 'unbilled' and te.deleted_at is null
                            and ($4::date is null or te.work_date <= $4))
              or exists (select 1 from deedbox.disbursement d
                          where d.matter = m.id and d.billed_state = 'unbilled' and d.billable and d.deleted_at is null
                            and ($4::date is null or d.incurred_date <= $4)))
          order by m.matter_number`,
        [
          filters.practiceArea ?? null,
          filters.office ?? null,
          filters.responsibleLawyer ?? null,
          filters.throughDate ?? null,
        ],
      )
      return r.rows.map((x) => ({
        id: x.id as number,
        matterNumber: x.matter_number as string,
        title: x.title as string,
        clientName: x.client_name as string,
        unbilledValue: Number(x.unbilled_value),
        heldAvailable: Number(x.held_available),
        billable: !x.billing_hold && x.status !== 'closed' && x.status !== 'archived',
        whyNot: x.billing_hold
          ? 'billing hold'
          : x.status === 'closed' || x.status === 'archived'
            ? `matter ${x.status}`
            : null,
      }))
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// bill view
// ---------------------------------------------------------------------------

export async function billView(p: Principal, billId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const b = await tx.query(
        `select b.id, b.bill_group, b.matter, b.payer_party, b.share_pct, b.state, b.bill_number,
                b.issue_date, b.terms_days_applied, b.due_date, b.interest_statement,
                b.rendered_artefact, b.reminder_exempt,
                m.matter_number, m.title, pt.display_name as payer_name,
                deedbox.bill_outstanding(b.id) as outstanding
           from deedbox.bill b
           join deedbox.matter m on m.id = b.matter
           join deedbox.party pt on pt.id = b.payer_party
          where b.id = $1`,
        [billId],
      )
      if (b.rowCount === 0) throw new OperationRefused('not_found', 'bill not found')
      const lines = await tx.query(
        `select position, kind, description, quantity_units, rate, original_value,
                written_down_to, amount, tax_treatment, tax_amount
           from deedbox.bill_line where bill = $1 order by position`,
        [billId],
      )
      const journal = await tx.query(
        `select j.id, j.entry_no, j.entry_kind, j.signed_amount, j.source_type, j.source,
                j.effective_date, j.entered_at, j.reason, j.reverses,
                exists (select 1 from deedbox.bill_journal_entry r where r.reverses = j.id) as reversed,
                s.person_name as entered_by_name
           from deedbox.bill_journal_entry j
           left join deedbox.staff_member s on s.id = j.entered_by
          where j.bill = $1 order by j.entry_no`,
        [billId],
      )
      const disputes = await tx.query(
        `select d.id, d.detail, d.raised_at, d.resolved_at, d.resolution_note,
                s.person_name as raised_by_name
           from deedbox.bill_dispute d join deedbox.staff_member s on s.id = d.raised_by
          where d.bill = $1 order by d.raised_at desc`,
        [billId],
      )
      const interestProposals = await tx.query(
        `select id, period_from, period_to, rate_pct_applied, amount, state, computed_at
           from deedbox.interest_charge_proposal where bill = $1
          order by id desc`,
        [billId],
      )
      const reminder = await tx.query(
        `select rs.status, rs.current_step_no, rs.next_step_at, rs.hold_reason,
                sq.name as sequence_name, sq.id as sequence
           from deedbox.bill_reminder_state rs
           join deedbox.reminder_sequence sq on sq.id = rs.sequence
          where rs.bill = $1`,
        [billId],
      )
      const contacts = await tx.query(
        `select step_no, channel, sent_at from deedbox.reminder_contact
          where bill = $1 order by sent_at desc`,
        [billId],
      )
      const arrangement = await tx.query(
        `select pa.id, pa.state, pa.instalment_amount, pa.frequency,
                (select count(*)::int from deedbox.instalment i
                  where i.arrangement = pa.id and i.state = 'paid') as paid,
                pa.instalment_count
           from deedbox.arrangement_bill ab
           join deedbox.payment_arrangement pa on pa.id = ab.arrangement
          where ab.bill = $1 and pa.state in ('active','broken')
          order by pa.id desc limit 1`,
        [billId],
      )
      const credits = await tx.query(
        `select cn.id, cn.credit_number, cn.amount, cn.reason,
                cn.amount - coalesce((select sum(-j.signed_amount) from deedbox.bill_journal_entry j
                  where j.entry_kind = 'credit_application' and j.source_type = 'credit_note'
                    and j.source = cn.id), 0) as remainder
           from deedbox.credit_note cn where cn.bill = $1 order by cn.id`,
        [billId],
      )
      const mayAttribution = await hasCapability(tx, p.id, 'security.administer')
      const attribution = mayAttribution
        ? (
            await tx.query(
              `select ba.staff, ba.billed_share, s.person_name
                 from deedbox.bill_attribution ba join deedbox.staff_member s on s.id = ba.staff
                where ba.bill = $1 and ba.superseded_at is null order by ba.billed_share desc`,
              [billId],
            )
          ).rows
        : null
      const sequences = await tx.query(
        `select id, name from deedbox.reminder_sequence where active order by name`,
      )
      return {
        bill: b.rows[0],
        lines: lines.rows,
        journal: journal.rows,
        disputes: disputes.rows,
        openDispute: disputes.rows.find((d) => d.resolved_at === null) ?? null,
        interestProposals: interestProposals.rows,
        reminder: reminder.rows[0] ?? null,
        contacts: contacts.rows,
        arrangement: arrangement.rows[0] ?? null,
        credits: credits.rows,
        attribution,
        sequences: sequences.rows as { id: number; name: string }[],
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// unpaid-bills register
// ---------------------------------------------------------------------------

export interface UnpaidFilters {
  matter?: number
  client?: number
  lawyer?: number
  office?: number
  ageBand?: string
}

export async function unpaidBills(p: Principal, f: UnpaidFilters = {}) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select y.*, ${AGE_BAND_SQL.replace(/age_days/g, 'y.age_days')} as age_band from (
           select b.id, b.bill_number, b.issue_date, b.due_date, b.matter, b.payer_party,
                  m.matter_number, m.title, m.responsible_lawyer, m.office,
                  pt.display_name as payer_name,
                  deedbox.bill_outstanding(b.id) as outstanding,
                  greatest((current_date - b.due_date)::int, 0) as age_days,
                  rs.status as reminder_status, rs.next_step_at, rs.current_step_no,
                  (select max(rc.sent_at) from deedbox.reminder_contact rc where rc.bill = b.id) as last_contact,
                  exists (select 1 from deedbox.bill_dispute d where d.bill = b.id and d.resolved_at is null) as disputed,
                  exists (select 1 from deedbox.arrangement_bill ab
                           join deedbox.payment_arrangement pa on pa.id = ab.arrangement
                          where ab.bill = b.id and pa.state = 'active') as arranged,
                  m.billing_hold
             from deedbox.bill b
             join deedbox.matter m on m.id = b.matter
             join deedbox.party pt on pt.id = b.payer_party
             left join deedbox.bill_reminder_state rs on rs.bill = b.id
            where b.state = 'issued' and deedbox.bill_outstanding(b.id) > 0
              and ($1::bigint is null or b.matter = $1)
              and ($2::bigint is null or b.payer_party = $2)
              and ($3::bigint is null or m.responsible_lawyer = $3)
              and ($4::bigint is null or m.office = $4)
         ) y
         where ($5::text is null or ${AGE_BAND_SQL.replace(/age_days/g, 'y.age_days')} = $5)
         order by y.age_days desc, y.outstanding desc
         limit 500`,
        [f.matter ?? null, f.client ?? null, f.lawyer ?? null, f.office ?? null, f.ageBand ?? null],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// payment entry & allocation
// ---------------------------------------------------------------------------

export async function paymentWorkbench(p: Principal, opts: { payer?: number } = {}) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const openBills = opts.payer
        ? (
            await tx.query(
              `select b.id, b.bill_number, b.due_date, b.matter, m.matter_number,
                      deedbox.bill_outstanding(b.id) as outstanding
                 from deedbox.bill b join deedbox.matter m on m.id = b.matter
                where b.state = 'issued' and b.payer_party = $1
                  and deedbox.bill_outstanding(b.id) > 0
                order by b.due_date`,
              [opts.payer],
            )
          ).rows
        : []
      const unallocated = await tx.query(
        `select rp.id, rp.receipt_number, rp.received_date, rp.amount, rp.method, rp.reference,
                pt.display_name as payer_name, rp.payer_party,
                rp.amount
              - coalesce((select sum(-j.signed_amount) from deedbox.bill_journal_entry j
                           where j.entry_kind = 'payment_allocation' and j.source_type = 'receivable_payment'
                             and j.source = rp.id), 0)
              - coalesce((select sum(rev.amount) from deedbox.receivable_payment rev where rev.reverses = rp.id), 0)
                as remainder
           from deedbox.receivable_payment rp
           left join deedbox.party pt on pt.id = rp.payer_party
          where rp.reverses is null
            and not exists (select 1 from deedbox.receivable_payment rev where rev.reverses = rp.id)
          order by rp.id desc limit 200`,
      )
      const allocationOrder = (await settingText(tx, 'statement.allocation_order')) ?? 'oldest_first'
      return {
        openBills,
        unallocated: unallocated.rows.filter((r) => Number(r.remainder) > 0),
        allocationOrder,
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// statements · arrangements
// ---------------------------------------------------------------------------

export async function statementsScreen(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select st.id, st.statement_number, st.scope_kind, st.scope, st.as_at, st.artefact,
                case st.scope_kind
                  when 'client' then (select display_name from deedbox.party where id = st.scope)
                  else (select matter_number from deedbox.matter where id = st.scope)
                end as scope_label
           from deedbox.receivable_statement st
          order by st.id desc limit 100`,
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function arrangementsScreen(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const arrangements = await tx.query(
        `select pa.id, pa.state, pa.instalment_amount, pa.frequency, pa.instalment_count,
                pa.covers_future_bills, pa.broken_at, pa.created_at, pa.matter,
                pt.display_name as client_name, m.matter_number,
                (select count(*)::int from deedbox.instalment i where i.arrangement = pa.id and i.state = 'paid') as paid,
                (select count(*)::int from deedbox.instalment i where i.arrangement = pa.id and i.state = 'missed') as missed
           from deedbox.payment_arrangement pa
           join deedbox.party pt on pt.id = pa.client_party
           left join deedbox.matter m on m.id = pa.matter
          order by (pa.state = 'broken') desc, pa.created_at desc limit 100`,
      )
      const instalments = await tx.query(
        `select i.arrangement, i.sequence_no, i.due_date, i.amount, i.state
           from deedbox.instalment i
          where i.arrangement = any($1)
          order by i.arrangement, i.sequence_no`,
        [arrangements.rows.map((a) => a.id as number)],
      )
      return { arrangements: arrangements.rows, instalments: instalments.rows }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// reminder configuration · channel panel · top-ups
// ---------------------------------------------------------------------------

export async function reminderConfig(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const sequences = await tx.query(
        `select id, name, active, default_for_new_bills from deedbox.reminder_sequence order by name`,
      )
      const steps = await tx.query(
        `select sequence, step_no, days_after_previous, channel, template
           from deedbox.reminder_step order by sequence, step_no`,
      )
      const templates = await tx.query(
        `select id, name, channel, purpose, active from deedbox.message_template
          where active order by purpose, name`,
      )
      const mayManage = await hasCapability(tx, p.id, 'reminders.manage')
      return {
        sequences: sequences.rows,
        steps: steps.rows,
        templates: templates.rows,
        mayManage,
      }
    },
    { readOnly: true },
  )
}

export async function channelPanel(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select cp.id, cp.channel, cp.method, cp.amount, cp.state, cp.surcharge_amount,
                cp.channel_event_ref, cp.created_at,
                cp.resulting_receipt_type, cp.resulting_receipt,
                pr.code as reference_code, pr.target_kind, pr.target
           from deedbox.channel_payment cp
           join deedbox.payment_reference pr on pr.id = cp.payment_reference
          order by (cp.state = 'started') desc, (cp.state = 'failed') desc, cp.id desc
          limit 100`,
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function topUpQueue(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select t.id, t.request_number, t.amount_requested, t.state, t.raised_at,
                t.attach_to_next_bill, fp.matter, m.matter_number, m.title,
                s.person_name as alerted_name, pr.code as reference_code
           from deedbox.top_up_request t
           join deedbox.matter_funds_policy fp on fp.id = t.funds_policy
           join deedbox.matter m on m.id = fp.matter
           join deedbox.staff_member s on s.id = t.alerted_staff
           left join deedbox.payment_reference pr on pr.id = t.payment_reference
          where t.state in ('pending_confirmation','issued')
          order by t.raised_at desc limit 100`,
      )
      return r.rows
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// held-funds runs · rates admin · payment details
// ---------------------------------------------------------------------------

export async function heldFundsRuns(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const runs = await tx.query(
        `select ar.id, ar.run_at, ar.scope, ar.state, s.person_name as run_by_name,
                (select count(*)::int from deedbox.funds_application fa where fa.run = ar.id) as items
           from deedbox.application_run ar join deedbox.staff_member s on s.id = ar.run_by
          order by ar.id desc limit 50`,
      )
      return runs.rows
    },
    { readOnly: true },
  )
}

export async function heldFundsRunDetail(p: Principal, runId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const run = await tx.query(
        `select ar.id, ar.run_at, ar.scope, ar.state, s.person_name as run_by_name
           from deedbox.application_run ar join deedbox.staff_member s on s.id = ar.run_by
          where ar.id = $1`,
        [runId],
      )
      if (run.rowCount === 0) throw new OperationRefused('not_found', 'application run not found')
      const items = await tx.query(
        `select fa.id, fa.bill, fa.amount, fa.item_state, fa.refusal_reason,
                b.bill_number, m.matter_number
           from deedbox.funds_application fa
           join deedbox.bill b on b.id = fa.bill
           join deedbox.matter m on m.id = b.matter
          where fa.run = $1 order by fa.id`,
        [runId],
      )
      return { run: run.rows[0], items: items.rows }
    },
    { readOnly: true },
  )
}

/** Everything the consolidated EFT requisition for one run says: every
 *  COMPLETED transfer with its numbers and approvals, grouped by the client
 *  account the money left, the firm's own receiving details, and the grand
 *  total — one form for the one bank transfer that covers them all. */
export async function heldFundsRunRequisition(p: Principal, runId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const run = await tx.query(
        `select ar.id, ar.run_at, ar.state, s.person_name as run_by_name,
                (select f.name from deedbox.firm f order by f.id limit 1) as firm_name
           from deedbox.application_run ar join deedbox.staff_member s on s.id = ar.run_by
          where ar.id = $1`,
        [runId],
      )
      if (run.rowCount === 0) throw new OperationRefused('not_found', 'application run not found')
      const items = await tx.query(
        `select fa.id, fa.amount,
                b.bill_number, m.matter_number, m.title as matter_title,
                l.ledger_number, a.id as account, a.name as account_name,
                a.bank_identifiers as account_bank_identifiers,
                rp.receipt_number, mp.payment_number, mp.executed_at,
                (select jsonb_agg(jsonb_build_object(
                          'name', ast.person_name, 'at', pa.at) order by pa.id)
                   from deedbox.payment_authorisation pa
                   join deedbox.staff_member ast on ast.id = pa.authoriser
                  where pa.subject_type = 'money_payment' and pa.subject = fa.money_payment
                    and pa.decision = 'approved') as approvals
           from deedbox.funds_application fa
           join deedbox.bill b on b.id = fa.bill
           join deedbox.matter m on m.id = b.matter
           join deedbox.matter_ledger l on l.id = fa.matter_ledger
           join deedbox.client_account a on a.id = l.account
           left join deedbox.receivable_payment rp on rp.id = fa.receivable_payment
           left join deedbox.money_payment mp on mp.id = fa.money_payment
          where fa.run = $1 and fa.item_state = 'completed'
          order by a.id, m.matter_number, fa.id`,
        [runId],
      )
      if (items.rowCount === 0) {
        throw new OperationRefused(
          'nothing_completed',
          'no transfer on this run has completed yet — the requisition covers executed transfers only',
        )
      }
      const other = await tx.query(
        `select count(*)::int as n from deedbox.funds_application
          where run = $1 and item_state <> 'completed'`,
        [runId],
      )
      const firmDetails = await tx.query(
        `select jsonb_build_object('account holder', gpd.account_holder_name, 'bank', gpd.bank_name)
                || gpd.identifier_values as details
           from deedbox.governing_payment_details() gpd where gpd.id is not null`,
      )
      const regional = await firmRegional(tx, p.firm)
      return {
        run: run.rows[0],
        items: items.rows,
        excluded: other.rows[0].n as number,
        firm_payee_details: firmDetails.rowCount === 0 ? null : firmDetails.rows[0].details,
        regional,
      }
    },
    { readOnly: true },
  )
}

export async function ratesAdmin(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const staffRates = await tx.query(
        `select r.id, r.staff, r.label, r.rate, r.effective_from, s.person_name
           from deedbox.staff_rate r join deedbox.staff_member s on s.id = r.staff
          order by s.login, r.label, r.effective_from desc limit 300`,
      )
      // Row security on see_cost_rates: without the capability this is empty.
      const costRates = await tx.query(
        `select r.id, r.staff, r.cost_rate as rate, r.effective_from, s.person_name
           from deedbox.staff_cost_rate r join deedbox.staff_member s on s.id = r.staff
          order by s.login, r.effective_from desc limit 300`,
      )
      const overrides = await tx.query(
        `select o.id, o.matter, o.staff, o.label, o.rate, o.effective_from,
                m.matter_number, s.person_name
           from deedbox.matter_rate_override o
           join deedbox.matter m on m.id = o.matter
           left join deedbox.staff_member s on s.id = o.staff
          order by o.id desc limit 200`,
      )
      const costTypes = await tx.query(
        `select id, name, default_amount, default_tax_treatment, active
           from deedbox.cost_type order by active desc, name`,
      )
      const seesCostRates = await hasCapability(tx, p.id, 'see_cost_rates')
      const staff = await tx.query(
        `select id, person_name from deedbox.staff_member where active order by login`,
      )
      return {
        staffRates: staffRates.rows,
        costRates: costRates.rows,
        overrides: overrides.rows,
        costTypes: costTypes.rows,
        seesCostRates,
        staffOptions: staff.rows.map((r) => ({ id: r.id as number, name: personNameText(r.person_name) })),
      }
    },
    { readOnly: true },
  )
}

export async function paymentDetailsScreen(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const versions = await tx.query(
        `select pd.id, pd.version_no, pd.account_holder_name, pd.bank_name, pd.identifier_values,
                pd.state, pd.created_at, pd.approved_at, pd.superseded_at,
                cs.person_name as created_by_name, aps.person_name as approved_by_name
           from deedbox.payment_details pd
           join deedbox.staff_member cs on cs.id = pd.created_by
           left join deedbox.staff_member aps on aps.id = pd.approved_by
          order by pd.version_no desc limit 20`,
      )
      const governing = versions.rows.find((v) => v.state === 'approved' && v.superseded_at === null)
      const pending = versions.rows.find((v) => v.state === 'pending')
      const requireApproval = await settingBool(tx, 'billing.payment_details_require_approval')
      // The CALLER'S FIRM's active pack drives the capture form's identifier
      // fields (firm-scope every pack join — the shared world holds many).
      const packFields = await tx.query(
        `select d.body from deedbox.pack_declaration d
           join deedbox.firm f on f.id = $1
           join deedbox.country_pack cp on cp.id = f.country_pack
           join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
          where d.rule_point = 'bank.account_identifiers' limit 1`,
        [p.firm],
      )
      return {
        versions: versions.rows,
        governing: governing ?? null,
        pending: pending ?? null,
        requireApproval,
        identifierSchema: (packFields.rows[0]?.body as { fields?: { key: string; label?: string }[] }) ?? null,
      }
    },
    { readOnly: true },
  )
}

/** Capability flags the billing screens branch on (display convenience). */
export async function billingViewerFlags(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => ({
      issue: await hasCapability(tx, p.id, 'bill.issue'),
      approve: await hasCapability(tx, p.id, 'bill.approve'),
      remindersManage: await hasCapability(tx, p.id, 'reminders.manage'),
      applyHeldFunds: await hasCapability(tx, p.id, 'money.apply_held_funds'),
      authorisePayment: await hasCapability(tx, p.id, 'money.authorise_payment'),
      seesCostRates: await hasCapability(tx, p.id, 'see_cost_rates'),
      admin: await hasCapability(tx, p.id, 'security.administer'),
    }),
    { readOnly: true },
  )
}

/**
 * The pack's declared tax treatments, for the capture forms: the choice a
 * screen offers is built FROM the active pack's own declarations (value =
 * the pack's discriminator, caption = the pack's label). Empty when no pack
 * rule governs — the form then shows no tax choice and no tax is computed.
 */
export async function taxTreatmentOptions(p: Principal): Promise<TaxTreatment[]> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => taxTreatments(tx, p.firm), { readOnly: true })
}

/**
 * The time-entry forms' record-for support (0053): whether the viewer may
 * record another person's time, and the active staff to choose from —
 * empty unless the permission is held, so the screens render nothing extra
 * for everyone else.
 */
export async function timeCaptureOptions(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const recordForOthers = await hasCapability(tx, p.id, 'time.record_for_others')
      // the viewer's own named rates: more than one label = a rate choice on
      // the form (the resolver's default label stays 'standard')
      const labels = await tx.query(
        `select distinct label from deedbox.staff_rate where staff = $1 order by label`,
        [p.id],
      )
      const ownRateLabels = labels.rows.map((r) => r.label as string)
      if (!recordForOthers) {
        return { recordForOthers, ownRateLabels, staffOptions: [] as { id: number; name: string }[] }
      }
      const staff = await tx.query(
        `select id, person_name from deedbox.staff_member where active order by login`,
      )
      return {
        recordForOthers,
        ownRateLabels,
        staffOptions: staff.rows.map((r) => ({ id: r.id as number, name: personNameText(r.person_name) })),
      }
    },
    { readOnly: true },
  )
}
