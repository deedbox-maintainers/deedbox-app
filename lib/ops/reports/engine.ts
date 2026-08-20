// Running a report and rendering dashboard tiles over the SHIPPED
// catalogue (seeded in 0016): the definitions live in the database as
// release content and the query builders bind to their keys here — one
// builder per key, every query predicate-bound (the matter row security
// filters restricted rows out of every join), rows and totals from one
// query plan at one instant. Reads are not registered: restricted rows are
// absent, so a report is never a restricted read.
//
// Visibility: the definition's roles admit the viewer's role (all_staff
// admits everyone); where a definition supports the own-figures scope, a
// viewer outside the roles who holds report.own_figures runs the report
// scoped to their own rows.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability } from '@/lib/ops/shared'

export interface ReportFilters {
  periodStart?: string
  periodEnd?: string
  practiceArea?: number
  office?: number
  /** Set by the engine when the own-figures scope applies. */
  ownStaff?: number
}

export interface ReportResult {
  key: string
  title: string
  columns: string[]
  rows: Record<string, unknown>[]
  totals: Record<string, number>
  ranAt: string
  ownFiguresScope: boolean
}

type Builder = (tx: Tx, p: Principal, f: ReportFilters) => Promise<Omit<ReportResult, 'key' | 'title' | 'ranAt' | 'ownFiguresScope'>>

function num(x: unknown): number {
  return x === null || x === undefined ? 0 : Number(x)
}

function sumColumn(rows: Record<string, unknown>[], col: string): number {
  return Math.round(rows.reduce((s, r) => s + num(r[col]) * 100, 0)) / 100
}

const builders: Record<string, Builder> = {
  matter_list_financials: async (tx, _p, f) => {
    const r = await tx.query(
      `select m.id as matter, m.matter_number, m.title, m.status,
              pa.name as practice_area,
              coalesce((select sum(te.value) from deedbox.time_entry te
                         where te.matter = m.id and te.billed_state = 'unbilled'
                           and te.deleted_at is null), 0)
            + coalesce((select sum(d.amount) from deedbox.disbursement d
                         where d.matter = m.id and d.billed_state = 'unbilled'
                           and d.billable and d.deleted_at is null), 0) as unbilled,
              coalesce((select sum(deedbox.bill_outstanding(b.id)) from deedbox.bill b
                         where b.matter = m.id and b.state = 'issued'), 0) as outstanding,
              coalesce((select sum(deedbox.ledger_available(ml.id)) from deedbox.matter_ledger ml
                         where ml.matter = m.id and ml.ledger_kind = 'client_matter'
                           and ml.status = 'open'), 0) as held_available
         from deedbox.matter m
         join deedbox.practice_area pa on pa.id = m.practice_area
        where ($1::bigint is null or m.practice_area = $1)
          and ($2::bigint is null or m.office = $2)
          and ($3::bigint is null or m.responsible_lawyer = $3)
        order by m.matter_number`,
      [f.practiceArea ?? null, f.office ?? null, f.ownStaff ?? null],
    )
    return {
      columns: ['matter_number', 'title', 'status', 'practice_area', 'unbilled', 'outstanding', 'held_available'],
      rows: r.rows,
      totals: {
        unbilled: sumColumn(r.rows, 'unbilled'),
        outstanding: sumColumn(r.rows, 'outstanding'),
        held_available: sumColumn(r.rows, 'held_available'),
      },
    }
  },

  unbilled_work_aged: async (tx, _p, f) => {
    const r = await tx.query(
      `select m.matter_number, m.id as matter, x.kind, x.item_date::text as item_date, x.value,
              case when current_date - x.item_date <= 30 then '0-30'
                   when current_date - x.item_date <= 60 then '31-60'
                   when current_date - x.item_date <= 90 then '61-90'
                   else '90+' end as age_band
         from (
           select te.matter, 'time' as kind, te.work_date as item_date, te.value, te.staff
             from deedbox.time_entry te
            where te.billed_state = 'unbilled' and te.deleted_at is null
           union all
           select d.matter, 'disbursement', d.incurred_date, d.amount, d.created_by
             from deedbox.disbursement d
            where d.billed_state = 'unbilled' and d.billable and d.deleted_at is null
         ) x
         join deedbox.matter m on m.id = x.matter
        where ($1::bigint is null or m.practice_area = $1)
          and ($2::bigint is null or x.staff = $2)
        order by x.item_date`,
      [f.practiceArea ?? null, f.ownStaff ?? null],
    )
    return {
      columns: ['matter_number', 'kind', 'item_date', 'age_band', 'value'],
      rows: r.rows,
      totals: { value: sumColumn(r.rows, 'value') },
    }
  },

  aged_receivables: async (tx, _p, f) => {
    const r = await tx.query(
      `select b.bill_number, m.matter_number, m.id as matter, b.due_date::text as due_date,
              deedbox.bill_outstanding(b.id) as outstanding,
              case when current_date - b.due_date <= 0 then 'current'
                   when current_date - b.due_date <= 30 then '1-30'
                   when current_date - b.due_date <= 60 then '31-60'
                   when current_date - b.due_date <= 90 then '61-90'
                   else '90+' end as age_band
         from deedbox.bill b join deedbox.matter m on m.id = b.matter
        where b.state = 'issued' and deedbox.bill_outstanding(b.id) > 0
          and ($1::bigint is null or m.practice_area = $1)
          and ($2::bigint is null or m.responsible_lawyer = $2)
        order by b.due_date`,
      [f.practiceArea ?? null, f.ownStaff ?? null],
    )
    return {
      columns: ['bill_number', 'matter_number', 'due_date', 'age_band', 'outstanding'],
      rows: r.rows,
      totals: { outstanding: sumColumn(r.rows, 'outstanding') },
    }
  },

  invoicing_by_lawyer: async (tx, _p, f) => {
    // every bill issued in the period with its journal position, carrying
    // the matter's responsible lawyer — the viewer's grouping does the
    // per-lawyer subtotals (0055)
    const r = await tx.query(
      `select coalesce(nullif(trim(coalesce(s.person_name->>'given','') || ' ' ||
                                   coalesce(s.person_name->>'family','')), ''),
                       s.person_name->>'display', s.login) as lawyer,
              m.matter_number, m.id as matter, cp.display_name as client_name,
              b.bill_number, b.issue_date::text as issue_date,
              it.amount as invoiced,
              coalesce(rec.amount, 0) as received,
              coalesce(wo.amount, 0) as written_off,
              deedbox.bill_outstanding(b.id) as owing
         from deedbox.bill b
         join deedbox.matter m on m.id = b.matter
         join deedbox.party cp on cp.id = m.client_party
         join deedbox.staff_member s on s.id = m.responsible_lawyer
         join lateral (
           select j.signed_amount as amount from deedbox.bill_journal_entry j
            where j.bill = b.id and j.entry_kind = 'issue_total'
         ) it on true
         left join lateral (
           select -sum(j.signed_amount) as amount from deedbox.bill_journal_entry j
            where j.bill = b.id and j.entry_kind in ('payment_allocation','credit_application')
         ) rec on true
         left join lateral (
           select -sum(j.signed_amount) as amount from deedbox.bill_journal_entry j
            where j.bill = b.id and j.entry_kind = 'write_off'
         ) wo on true
        where b.state = 'issued'
          and b.issue_date between coalesce($1::date, date_trunc('month', current_date)::date)
                               and coalesce($2::date, current_date)
          and ($3::bigint is null or m.practice_area = $3)
          and ($4::bigint is null or m.responsible_lawyer = $4)
        order by lawyer, b.issue_date, b.id`,
      [f.periodStart ?? null, f.periodEnd ?? null, f.practiceArea ?? null, f.ownStaff ?? null],
    )
    return {
      columns: ['lawyer', 'matter_number', 'client_name', 'bill_number', 'issue_date', 'invoiced', 'received', 'written_off', 'owing'],
      rows: r.rows,
      totals: {
        invoiced: sumColumn(r.rows, 'invoiced'),
        received: sumColumn(r.rows, 'received'),
        written_off: sumColumn(r.rows, 'written_off'),
        owing: sumColumn(r.rows, 'owing'),
      },
    }
  },

  billing_activity: async (tx, _p, f) => {
    const r = await tx.query(
      `select j.effective_date::text as effective_date, j.entry_kind, j.signed_amount,
              b.bill_number, m.matter_number, m.id as matter
         from deedbox.bill_journal_entry j
         join deedbox.bill b on b.id = j.bill
         join deedbox.matter m on m.id = b.matter
        where j.effective_date between coalesce($1::date, date_trunc('month', current_date)::date)
                                   and coalesce($2::date, current_date)
          and ($3::bigint is null or m.responsible_lawyer = $3)
        order by j.effective_date, j.id`,
      [f.periodStart ?? null, f.periodEnd ?? null, f.ownStaff ?? null],
    )
    return {
      columns: ['effective_date', 'entry_kind', 'bill_number', 'matter_number', 'signed_amount'],
      rows: r.rows,
      totals: { signed_amount: sumColumn(r.rows, 'signed_amount') },
    }
  },

  client_money_receipts_payments: async (tx, _p, f) => {
    const r = await tx.query(
      `select t.effective_date::text as effective_date, t.txn_kind, ll.signed_amount,
              ml.ledger_number, m.matter_number, m.id as matter
         from deedbox.ledger_line ll
         join deedbox.money_transaction t on t.id = ll.transaction
         join deedbox.matter_ledger ml on ml.id = ll.matter_ledger
         join deedbox.matter m on m.id = ml.matter
        where ll.side = 'matter_ledger'
          and t.effective_date between coalesce($1::date, date_trunc('month', current_date)::date)
                                   and coalesce($2::date, current_date)
        order by t.effective_date, ll.id`,
      [f.periodStart ?? null, f.periodEnd ?? null],
    )
    return {
      columns: ['effective_date', 'txn_kind', 'ledger_number', 'matter_number', 'signed_amount'],
      rows: r.rows,
      totals: { signed_amount: sumColumn(r.rows, 'signed_amount') },
    }
  },

  ledger_listings: async (tx) => {
    const r = await tx.query(
      `select ml.ledger_number, ml.ledger_kind, ml.status, m.matter_number, m.id as matter,
              deedbox.ledger_balance(ml.id) as balance,
              deedbox.ledger_active_earmarks(ml.id) as earmarked,
              deedbox.ledger_available(ml.id) as available
         from deedbox.matter_ledger ml
         left join deedbox.matter m on m.id = ml.matter
        order by ml.id`,
    )
    return {
      columns: ['ledger_number', 'ledger_kind', 'status', 'matter_number', 'balance', 'earmarked', 'available'],
      rows: r.rows,
      totals: { balance: sumColumn(r.rows, 'balance'), available: sumColumn(r.rows, 'available') },
    }
  },

  refusal_register: async (tx) => {
    const r = await tx.query(
      `select ro.id, ro.at::text as at, ro.refusal_reason, ro.attempted_by_kind,
              ro.promoted_incident, ca.name as account_name
         from deedbox.refused_operation ro
         join deedbox.client_account ca on ca.id = ro.account
        order by ro.at desc`,
    )
    return { columns: ['at', 'refusal_reason', 'account_name', 'promoted_incident'], rows: r.rows, totals: {} }
  },

  deficiency_incidents: async (tx) => {
    const r = await tx.query(
      `select di.id, di.incident_date::text as incident_date, di.state, di.cause, di.amount,
              ca.name as account_name
         from deedbox.deficiency_incident di
         join deedbox.client_account ca on ca.id = di.account
        order by di.incident_date desc`,
    )
    return {
      columns: ['incident_date', 'state', 'cause', 'amount', 'account_name'],
      rows: r.rows,
      totals: { amount: sumColumn(r.rows, 'amount') },
    }
  },

  matter_profitability: async (tx, p) => {
    // cost joins only where the viewer can see cost rates; the row-security
    // policy on cost rates means absent rows, never assumed zeros
    const seeCost = await hasCapability(tx, p.id, 'see_cost_rates')
    const r = await tx.query(
      `select m.matter_number, m.id as matter, pa.name as practice_area,
              coalesce((select sum(j.signed_amount) from deedbox.bill_journal_entry j
                         join deedbox.bill b on b.id = j.bill
                        where b.matter = m.id and j.entry_kind in ('issue_total','interest_charge')), 0) as billed,
              coalesce((select -sum(j.signed_amount) from deedbox.bill_journal_entry j
                         join deedbox.bill b on b.id = j.bill
                        where b.matter = m.id and j.entry_kind = 'payment_allocation'
                          and not exists (select 1 from deedbox.bill_journal_entry rv where rv.reverses = j.id)), 0) as collected
         from deedbox.matter m
         join deedbox.practice_area pa on pa.id = m.practice_area
        order by m.matter_number`,
    )
    return {
      columns: seeCost
        ? ['matter_number', 'practice_area', 'billed', 'collected']
        : ['matter_number', 'practice_area', 'billed', 'collected'],
      rows: r.rows,
      totals: { billed: sumColumn(r.rows, 'billed'), collected: sumColumn(r.rows, 'collected') },
    }
  },

  practice_area_profitability: async (tx) => {
    const r = await tx.query(
      `select pa.name as practice_area,
              coalesce(sum((select sum(j.signed_amount) from deedbox.bill_journal_entry j
                             join deedbox.bill b on b.id = j.bill
                            where b.matter = m.id and j.entry_kind in ('issue_total','interest_charge'))), 0) as billed
         from deedbox.matter m
         join deedbox.practice_area pa on pa.id = m.practice_area
        group by pa.name order by pa.name`,
    )
    return {
      columns: ['practice_area', 'billed'],
      rows: r.rows,
      totals: { billed: sumColumn(r.rows, 'billed') },
    }
  },

  staff_performance: async (tx, _p, f) => {
    const r = await tx.query(
      `select s.id as staff, s.person_name ->> 'display' as staff_name,
              coalesce((select sum(te.units) from deedbox.time_entry te
                         where te.staff = s.id and te.deleted_at is null
                           and te.work_date between coalesce($1::date, date_trunc('month', current_date)::date)
                                                and coalesce($2::date, current_date)), 0) as units_recorded,
              coalesce((select sum(te.value) from deedbox.time_entry te
                         where te.staff = s.id and te.deleted_at is null
                           and te.work_date between coalesce($1::date, date_trunc('month', current_date)::date)
                                                and coalesce($2::date, current_date)), 0) as value_recorded,
              coalesce((select sum(ba.billed_share) from deedbox.bill_attribution ba
                         where ba.staff = s.id and ba.superseded_at is null), 0) as billed_attributed,
              coalesce((select sum(ca.amount) from deedbox.collection_attribution ca
                         join deedbox.bill_journal_entry j on j.id = ca.allocation_entry
                        where ca.staff = s.id and j.entry_kind = 'payment_allocation'), 0) as collected_attributed
         from deedbox.staff_member s
        where s.active and ($3::bigint is null or s.id = $3)
        order by s.id`,
      [f.periodStart ?? null, f.periodEnd ?? null, f.ownStaff ?? null],
    )
    return {
      columns: ['staff_name', 'units_recorded', 'value_recorded', 'billed_attributed', 'collected_attributed'],
      rows: r.rows,
      totals: {
        value_recorded: sumColumn(r.rows, 'value_recorded'),
        billed_attributed: sumColumn(r.rows, 'billed_attributed'),
        collected_attributed: sumColumn(r.rows, 'collected_attributed'),
      },
    }
  },
}

/** Single-value tiles and view sources share the registry. */
const tileBuilders: Record<string, Builder> = {
  tile_matters_opened: async (tx, _p, f) => {
    const r = await tx.query(
      `select count(*)::int as n from deedbox.matter
        where opened_date between coalesce($1::date, date_trunc('month', current_date)::date)
                                   and coalesce($2::date, current_date)`,
      [f.periodStart ?? null, f.periodEnd ?? null],
    )
    return { columns: ['count'], rows: [{ count: r.rows[0].n }], totals: { count: r.rows[0].n as number } }
  },
  tile_matters_closed: async (tx, _p, f) => {
    // closure timing lives on the register: the status-change event's date
    const r = await tx.query(
      `select count(distinct re.subject)::int as n from deedbox.register_entry re
        where re.event_kind = 'matter.status_changed'
          and re.detail ->> 'after' in ('closed','archived')
          and re.occurred_at::date between coalesce($1::date, date_trunc('month', current_date)::date)
                              and coalesce($2::date, current_date)`,
      [f.periodStart ?? null, f.periodEnd ?? null],
    )
    return { columns: ['count'], rows: [{ count: r.rows[0].n }], totals: { count: r.rows[0].n as number } }
  },
  tile_unbilled_work: async (tx, p, f) => builders.unbilled_work_aged(tx, p, f).then((x) => ({
    columns: ['value'],
    rows: [{ value: x.totals.value }],
    totals: { value: x.totals.value },
  })),
  tile_outstanding_by_age: async (tx, p, f) => {
    const full = await builders.aged_receivables(tx, p, f)
    const bands: Record<string, number> = {}
    for (const row of full.rows) {
      const band = row.age_band as string
      bands[band] = Math.round(((bands[band] ?? 0) + num(row.outstanding)) * 100) / 100
    }
    return {
      columns: ['age_band', 'outstanding'],
      rows: Object.entries(bands).map(([age_band, outstanding]) => ({ age_band, outstanding })),
      totals: { outstanding: full.totals.outstanding },
    }
  },
  tile_client_money_available: async (tx) => {
    const r = await tx.query(
      `select coalesce(sum(deedbox.ledger_available(ml.id)), 0) as v
         from deedbox.matter_ledger ml
        where ml.ledger_kind = 'client_matter' and ml.status = 'open'`,
    )
    return { columns: ['available'], rows: [{ available: num(r.rows[0].v) }], totals: { available: num(r.rows[0].v) } }
  },
  tile_billed_this_period: async (tx, _p, f) => {
    const r = await tx.query(
      `select coalesce(sum(j.signed_amount), 0) as v from deedbox.bill_journal_entry j
        where j.entry_kind = 'issue_total'
          and j.effective_date between coalesce($1::date, date_trunc('month', current_date)::date)
                                   and coalesce($2::date, current_date)`,
      [f.periodStart ?? null, f.periodEnd ?? null],
    )
    return { columns: ['billed'], rows: [{ billed: num(r.rows[0].v) }], totals: { billed: num(r.rows[0].v) } }
  },
  tile_collected_this_period: async (tx, _p, f) => {
    const r = await tx.query(
      `select coalesce(-sum(j.signed_amount), 0) as v from deedbox.bill_journal_entry j
        where j.entry_kind = 'payment_allocation'
          and not exists (select 1 from deedbox.bill_journal_entry rv where rv.reverses = j.id)
          and j.effective_date between coalesce($1::date, date_trunc('month', current_date)::date)
                                   and coalesce($2::date, current_date)`,
      [f.periodStart ?? null, f.periodEnd ?? null],
    )
    return { columns: ['collected'], rows: [{ collected: num(r.rows[0].v) }], totals: { collected: num(r.rows[0].v) } }
  },
  tile_my_recorded: async (tx, p, f) => {
    const r = await builders.staff_performance(tx, p, { ...f, ownStaff: p.id })
    const mine = r.rows[0] ?? { units_recorded: 0, value_recorded: 0 }
    return {
      columns: ['units_recorded', 'value_recorded'],
      rows: [mine],
      totals: { value_recorded: num(mine.value_recorded) },
    }
  },
  tile_my_billed: async (tx, p) => {
    const r = await tx.query(
      `select coalesce(sum(ba.billed_share), 0) as v from deedbox.bill_attribution ba
        where ba.staff = $1 and ba.superseded_at is null`,
      [p.id],
    )
    return { columns: ['billed'], rows: [{ billed: num(r.rows[0].v) }], totals: { billed: num(r.rows[0].v) } }
  },
  tile_my_collected: async (tx, p) => {
    const r = await tx.query(
      `select coalesce(sum(ca.amount), 0) as v from deedbox.collection_attribution ca
        join deedbox.bill_journal_entry j on j.id = ca.allocation_entry
       where ca.staff = $1 and j.entry_kind = 'payment_allocation'`,
      [p.id],
    )
    return { columns: ['collected'], rows: [{ collected: num(r.rows[0].v) }], totals: { collected: num(r.rows[0].v) } }
  },
  tile_my_targets: async (tx, p) => {
    const r = await tx.query(
      `select metric, amount, period_kind, period_start::text as period_start
         from deedbox.performance_target
        where subject_kind = 'staff' and subject = $1 and deleted_at is null
        order by period_start desc`,
      [p.id],
    )
    return { columns: ['metric', 'amount', 'period_kind', 'period_start'], rows: r.rows, totals: {} }
  },
}

const viewBuilders: Record<string, Builder> = {
  view_critical_dates: async (tx) => {
    const r = await tx.query(
      `select k.title, k.starts_at, m.matter_number, m.id as matter
         from deedbox.key_date k join deedbox.matter m on m.id = k.matter
        where k.critical and not k.done and k.deleted_at is null
        order by k.starts_at`,
    )
    return { columns: ['title', 'starts_at', 'matter_number'], rows: r.rows, totals: {} }
  },
  view_my_tasks: async (tx, p) => {
    const r = await tx.query(
      `select t.id, t.title, t.due_date::text as due_date, m.matter_number
         from deedbox.task t left join deedbox.matter m on m.id = t.matter
        where t.owner = $1 and not t.done and t.deleted_at is null
        order by t.due_date nulls last, t.id`,
      [p.id],
    )
    return { columns: ['title', 'due_date', 'matter_number'], rows: r.rows, totals: {} }
  },
  view_matter_tasks: async (tx) => {
    const r = await tx.query(
      `select t.id, t.title, t.owner, t.due_date::text as due_date, m.matter_number, m.id as matter
         from deedbox.task t join deedbox.matter m on m.id = t.matter
        where not t.done and t.deleted_at is null
        order by m.matter_number, t.due_date nulls last`,
    )
    return { columns: ['matter_number', 'title', 'owner', 'due_date'], rows: r.rows, totals: {} }
  },
  view_recompute_proposals: async (tx) => {
    const r = await tx.query(
      `select p.id, m.matter_number, m.id as matter, p.created_at
         from deedbox.date_recompute_proposal p join deedbox.matter m on m.id = p.matter
        where p.state = 'pending' order by p.created_at`,
    )
    return { columns: ['matter_number', 'created_at'], rows: r.rows, totals: {} }
  },
  view_unpaid_bills: async (tx, p, f) => builders.aged_receivables(tx, p, f),
  view_import_batches: async (tx) => {
    const r = await tx.query(
      `select id, mode, state, started_at from deedbox.import_batch order by id desc limit 100`,
    )
    return { columns: ['id', 'mode', 'state', 'started_at'], rows: r.rows, totals: {} }
  },
  view_key_activity: async (tx) => {
    const r = await tx.query(
      `select re.event_kind, re.subject_type, re.subject, re.occurred_at as at
         from deedbox.register_entry re
        where re.event_kind in ('key.used','key.issued','key.revoked')
        order by re.id desc limit 200`,
    )
    return { columns: ['event_kind', 'subject_type', 'subject', 'at'], rows: r.rows, totals: {} }
  },
  view_export_history: async (tx) => {
    const r = await tx.query(
      `select re.occurred_at as at, re.actor, re.subject_type, re.artefact, re.detail
         from deedbox.register_entry re
        where re.event_kind = 'export.performed' order by re.id desc limit 200`,
    )
    return { columns: ['at', 'actor', 'subject_type', 'artefact'], rows: r.rows, totals: {} }
  },
  view_signin_history: async (tx) => {
    const r = await tx.query(
      `select re.occurred_at as at, re.actor_kind, re.actor, re.event_kind
         from deedbox.register_entry re
        where re.event_kind in ('signin.succeeded','signin.failed','session.ended')
        order by re.id desc limit 200`,
    )
    return { columns: ['at', 'actor_kind', 'actor', 'event_kind'], rows: r.rows, totals: {} }
  },
}

const registry: Record<string, Builder> = { ...builders, ...tileBuilders, ...viewBuilders }

interface Definition {
  id: number
  key: string
  title: string
  visibility_roles: string[]
  own_figures_scope_supported: boolean
  category: string
  schedulable: boolean
}

export async function loadDefinitionInTx(tx: Tx, key: string): Promise<Definition> {
  const r = await tx.query(
    `select id, key, title, visibility_roles, own_figures_scope_supported, category, schedulable
       from deedbox.report_definition where key = $1`,
    [key],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', `no report definition ${key}`)
  return r.rows[0] as Definition
}

/** The visibility decision: roles, or the own-figures fallback. */
export async function reportScopeInTx(
  tx: Tx,
  p: Principal,
  def: Definition,
): Promise<{ ownFigures: boolean }> {
  const role = await tx.query(
    `select r.system_key from deedbox.staff_member s
      join deedbox.role r on r.id = s.role where s.id = $1`,
    [p.id],
  )
  const systemKey = role.rowCount! > 0 ? (role.rows[0].system_key as string | null) : null
  const roles = def.visibility_roles
  if (roles.includes('all_staff') || (systemKey !== null && roles.includes(systemKey))) {
    return { ownFigures: false }
  }
  if (def.own_figures_scope_supported && (await hasCapability(tx, p.id, 'report.own_figures'))) {
    return { ownFigures: true }
  }
  throw new OperationRefused('not_visible', 'this report is not available to your role')
}

/** Run a report or tile by key, one instant, predicate-bound. */
export async function runReport(
  p: Principal,
  input: { key: string; filters?: ReportFilters },
): Promise<ReportResult> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => runReportInTx(tx, p, input.key, input.filters ?? {}),
    { readOnly: true },
  )
}

export async function runReportInTx(
  tx: Tx,
  p: Principal,
  key: string,
  filters: ReportFilters,
): Promise<ReportResult> {
  const def = await loadDefinitionInTx(tx, key)
  const scope = await reportScopeInTx(tx, p, def)
  const builder = registry[key]
  if (!builder) {
    throw new OperationRefused('not_built', `the ${key} builder is missing — a release defect`)
  }
  const effective = scope.ownFigures ? { ...filters, ownStaff: p.id } : filters
  const out = await builder(tx, p, effective)
  const at = await tx.query(`select now()::text as t`)
  return {
    key,
    title: def.title,
    ...out,
    ranAt: at.rows[0].t as string,
    ownFiguresScope: scope.ownFigures,
  }
}
