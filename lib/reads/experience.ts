// Predicate-governed reads for the operations/experience screens.
// Read-only withPrincipal transactions; the matter row policy does the
// hiding everywhere a matter joins in ("predicate at render" is literal:
// a pin or recent whose matter has become invisible simply drops out of
// the join). Figures of record are the engine's — the report and tile
// builders are the single home of every aggregate; these reads only serve
// the navigation shell around them.

import type { Principal } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, settingText } from '@/lib/ops/shared'

// ---------------------------------------------------------------------------
// Home: pins, recents (predicate at render), my open tasks, my pending
// proposals. Quick capture is links; the tiles are the dashboards'.
// ---------------------------------------------------------------------------

export async function homeScreen(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const pins = await tx.query(
        `select pi.item_type, pi.item, pi.position,
                case when pi.item_type = 'matter' then m.matter_number || ' — ' || m.title
                     else pt.display_name end as title
           from deedbox.pinned_item pi
           left join deedbox.matter m on m.id = pi.item and pi.item_type = 'matter'
           left join deedbox.party pt on pt.id = pi.item and pi.item_type = 'party'
          where pi.staff = $1
            and (pi.item_type <> 'matter' or m.id is not null)
            and (pi.item_type <> 'party'
                 or (pt.id is not null and pt.deleted_at is null and pt.state = 'active'))
          order by pi.position`,
        [p.id],
      )
      const recents = await tx.query(
        `select ri.item_type, ri.item, ri.last_viewed_at,
                case when ri.item_type = 'matter' then m.matter_number || ' — ' || m.title
                     else pt.display_name end as title
           from deedbox.recent_item ri
           left join deedbox.matter m on m.id = ri.item and ri.item_type = 'matter'
           left join deedbox.party pt on pt.id = ri.item and ri.item_type = 'party'
          where ri.staff = $1
            and (ri.item_type <> 'matter' or m.id is not null)
            and (ri.item_type <> 'party'
                 or (pt.id is not null and pt.deleted_at is null and pt.state = 'active'))
          order by ri.last_viewed_at desc
          limit 12`,
        [p.id],
      )
      const tasks = await tx.query(
        `select t.id, t.title, t.due_date::text as due_date,
                t.due_date is not null and t.due_date < current_date as overdue,
                m.matter_number, m.id as matter
           from deedbox.task t
           left join deedbox.matter m on m.id = t.matter
          where t.owner = $1 and not t.done and t.deleted_at is null
          order by t.due_date nulls last, t.id
          limit 15`,
        [p.id],
      )
      const proposals = await tx.query(
        `select count(*)::int as n from (
           select p1.id from deedbox.date_recompute_proposal p1
             join deedbox.matter m1 on m1.id = p1.matter
            where p1.state = 'pending'
           union all
           select p2.id from deedbox.slot_reresolution_proposal p2
             join deedbox.matter m2 on m2.id = p2.matter
            where p2.state = 'pending') x`,
      )
      return {
        pins: pins.rows,
        recents: recents.rows,
        tasks: tasks.rows,
        pendingProposals: proposals.rows[0].n as number,
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Dashboards: the period window from the setting; the tiles themselves
// are runReport calls the pages make — the engine owns every figure.
// ---------------------------------------------------------------------------

export async function dashboardPeriod(
  p: Principal,
): Promise<{ periodStart: string; periodEnd: string; label: string }> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const kind = (await settingText(tx, 'reporting.dashboard_period')) ?? 'calendar_month'
      const r = await tx.query(
        `select case $1
                  when 'calendar_quarter' then date_trunc('quarter', current_date)::date
                  when 'calendar_year' then date_trunc('year', current_date)::date
                  when 'rolling_30' then current_date - 30
                  else date_trunc('month', current_date)::date
                end::text as ps,
                current_date::text as pe`,
        [kind],
      )
      return {
        periodStart: r.rows[0].ps as string,
        periodEnd: r.rows[0].pe as string,
        label: String(kind).replace(/_/g, ' '),
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Matter stages & tasks panel + key dates & anchors panel — one read
// serves the matter's workflow tab. The headline position is the one
// stage-derived display, labelled; drill-through is the matter's own
// screens.
// ---------------------------------------------------------------------------

export async function matterWorkflowTab(p: Principal, matter: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const m = await tx.query(
        `select id, matter_number, title, status, practice_area from deedbox.matter where id = $1`,
        [matter],
      )
      if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
      const stages = await tx.query(
        `select ms.id, ms.name, ms.position, ms.state, ms.entered_at,
                ts.expected_duration_days
           from deedbox.matter_stage ms
           left join deedbox.template_stage ts on ts.id = ms.template_origin
          where ms.matter = $1
          order by ms.position`,
        [matter],
      )
      const tasks = await tx.query(
        `select t.id, t.title, t.stage, t.owner, t.due_date::text as due_date, t.done,
                t.origin, t.due_rule,
                s.person_name as owner_name,
                t.due_date is not null and t.due_date < current_date and not t.done as overdue
           from deedbox.task t
           left join deedbox.staff_member s on s.id = t.owner
          where t.matter = $1 and t.deleted_at is null
          order by t.done, t.due_date nulls last, t.id`,
        [matter],
      )
      const awaitingAnchor = tasks.rows.filter(
        (t) =>
          !t.done &&
          t.due_date === null &&
          t.due_rule !== null &&
          (t.due_rule as { basis?: string }).basis !== 'none',
      )
      const keyDates = await tx.query(
        `select k.id, k.kind, k.title, k.starts_at, k.ends_at, k.critical, k.done,
                ci.label as type_label
           from deedbox.key_date k
           join deedbox.choice_item ci on ci.id = k.type
          where k.matter = $1 and k.deleted_at is null
          order by k.starts_at`,
        [matter],
      )
      const anchors = await tx.query(
        `select ad.id as definition, ad.name, mad.value::text as value
           from deedbox.anchor_date_definition ad
           left join deedbox.matter_anchor_date mad
             on mad.definition = ad.id and mad.matter = $1
          where ad.active
          order by ad.name`,
        [matter],
      )
      const pendingDates = await tx.query(
        `select id, changes, created_at from deedbox.date_recompute_proposal
          where matter = $1 and state = 'pending'`,
        [matter],
      )
      const pendingSlots = await tx.query(
        `select id, items as changes, created_at from deedbox.slot_reresolution_proposal
          where matter = $1 and state = 'pending'`,
        [matter],
      )
      const templates = await tx.query(
        `select wt.id, wt.name from deedbox.workflow_template wt
          where wt.active and wt.practice_area = $2
            and not exists (select 1 from deedbox.matter_stage ms where ms.matter = $1)
          order by wt.name`,
        [matter, m.rows[0].practice_area],
      )
      const keyDateTypes = await tx.query(
        `select ci.shipped_key, ci.label from deedbox.choice_item ci
           join deedbox.choice_list cl on cl.id = ci.list
          where cl.purpose_key = 'key_date_types' and ci.active and ci.shipped_key is not null
          order by ci.position`,
      )
      const staff = await tx.query(
        `select id, person_name from deedbox.staff_member where active order by id`,
      )
      const position = await tx.query(
        `select unbilled_value, outstanding_value, held_available, as_at_register_seq
           from deedbox.matter_position_cache where matter = $1`,
        [matter],
      )
      return {
        matter: m.rows[0],
        stages: stages.rows,
        tasks: tasks.rows,
        awaitingAnchor,
        keyDates: keyDates.rows,
        anchors: anchors.rows,
        pendingDateProposals: pendingDates.rows,
        pendingSlotProposals: pendingSlots.rows,
        applicableTemplates: templates.rows,
        keyDateTypes: keyDateTypes.rows,
        staff: staff.rows,
        position: position.rows[0] ?? null,
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// My tasks queue — filters over the view_my_tasks shape, plus reassign
// targets.
// ---------------------------------------------------------------------------

export async function myTasksQueue(
  p: Principal,
  filters: { matter?: number; origin?: string } = {},
) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const tasks = await tx.query(
        `select t.id, t.title, t.due_date::text as due_date, t.origin, t.stage,
                t.due_date is not null and t.due_date < current_date as overdue,
                m.matter_number, m.id as matter, ms.name as stage_name
           from deedbox.task t
           left join deedbox.matter m on m.id = t.matter
           left join deedbox.matter_stage ms on ms.id = t.stage
          where t.owner = $1 and not t.done and t.deleted_at is null
            and ($2::bigint is null or t.matter = $2)
            and ($3::text is null or t.origin = $3)
          order by t.due_date nulls last, t.id`,
        [p.id, filters.matter ?? null, filters.origin ?? null],
      )
      const staff = await tx.query(
        `select id, person_name from deedbox.staff_member where active order by id`,
      )
      return { tasks: tasks.rows, staff: staff.rows }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Firm-wide critical dates view — overdue first, then upcoming within the
// horizon; the horizon named for the empty state.
// ---------------------------------------------------------------------------

export async function criticalDatesView(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const horizon = Number((await settingText(tx, 'keydates.critical_horizon_days')) ?? 30)
      const rows = await tx.query(
        `select k.id, k.title, k.starts_at, k.kind, ci.label as type_label,
                k.starts_at < now() as overdue,
                m.matter_number, m.id as matter,
                rl.person_name as owner_lawyer
           from deedbox.key_date k
           join deedbox.matter m on m.id = k.matter
           join deedbox.choice_item ci on ci.id = k.type
           left join deedbox.staff_member rl on rl.id = m.responsible_lawyer
          where k.critical and not k.done and k.deleted_at is null
            and k.starts_at <= now() + make_interval(days => $1)
          order by (k.starts_at >= now()), k.starts_at`,
        [horizon],
      )
      return { horizon, rows: rows.rows }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Proposals queue — pending date-recompute and slot-re-resolution
// proposals across visible matters, oldest first; the confirm screens render
// every item old → new.
// ---------------------------------------------------------------------------

export async function proposalsQueue(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const dates = await tx.query(
        `select pr.id, pr.created_at, pr.changes, m.matter_number, m.id as matter
           from deedbox.date_recompute_proposal pr
           join deedbox.matter m on m.id = pr.matter
          where pr.state = 'pending'
          order by pr.created_at`,
      )
      const slots = await tx.query(
        `select pr.id, pr.created_at, pr.items as changes, m.matter_number, m.id as matter
           from deedbox.slot_reresolution_proposal pr
           join deedbox.matter m on m.id = pr.matter
          where pr.state = 'pending'
          order by pr.created_at`,
      )
      return { dates: dates.rows, slots: slots.rows }
    },
    { readOnly: true },
  )
}

export async function proposalDetail(
  p: Principal,
  input: { kind: 'date' | 'slot'; id: number },
) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        input.kind === 'date'
          ? `select pr.id, pr.state, pr.created_at, pr.changes, m.matter_number, m.id as matter
               from deedbox.date_recompute_proposal pr join deedbox.matter m on m.id = pr.matter
              where pr.id = $1`
          : `select pr.id, pr.state, pr.created_at, pr.items as changes, m.matter_number, m.id as matter
               from deedbox.slot_reresolution_proposal pr join deedbox.matter m on m.id = pr.matter
              where pr.id = $1`,
        [input.id],
      )
      if (r.rowCount === 0) throw new OperationRefused('not_found', 'proposal not found')
      return r.rows[0]
    },
    { readOnly: true },
  )
}
