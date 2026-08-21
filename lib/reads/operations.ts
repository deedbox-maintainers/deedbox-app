// Predicate-governed reads for the operations screens: the report
// catalogue and its saved/scheduled layers, targets & groups, the import
// wizard's batch and mapping records, integration keys, the outbound
// message log, and the person's own devices and sessions. Figures of
// record stay the engine's; these reads serve the administration shells.

import type { Principal } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability } from '@/lib/ops/shared'

// ---------------------------------------------------------------------------
// Report catalogue: standard + shared + mine, visibility-filtered the
// same way the engine decides at run time (roles, or own-figures).
// ---------------------------------------------------------------------------

export async function reportCatalogue(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const role = await tx.query(
        `select r.system_key from deedbox.staff_member s
          join deedbox.role r on r.id = s.role where s.id = $1`,
        [p.id],
      )
      const systemKey = role.rowCount! > 0 ? (role.rows[0].system_key as string | null) : null
      const ownFigures = await hasCapability(tx, p.id, 'report.own_figures')
      const defs = await tx.query(
        `select id, key, title, category, tile_group, schedulable,
                visibility_roles, own_figures_scope_supported
           from deedbox.report_definition
          where category = 'standard_report'
          order by key`,
      )
      const visible = defs.rows.filter((d) => {
        const roles = d.visibility_roles as string[]
        if (roles.includes('all_staff')) return true
        if (systemKey !== null && roles.includes(systemKey)) return true
        return Boolean(d.own_figures_scope_supported) && ownFigures
      })
      const saved = await tx.query(
        `select sr.id, sr.name, sr.shared, sr.owner, sr.filters, rd.key, rd.title,
                s.person_name as owner_name
           from deedbox.saved_report sr
           join deedbox.report_definition rd on rd.id = sr.definition
           join deedbox.staff_member s on s.id = sr.owner
          where sr.deleted_at is null and (sr.owner = $1 or sr.shared)
          order by sr.name`,
        [p.id],
      )
      return { definitions: visible, saved: saved.rows }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Schedule manager: next run, recipients, paused reasons, skip counts.
// ---------------------------------------------------------------------------

export async function scheduleManager(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const manageAll = await hasCapability(tx, p.id, 'report.schedule_manage')
      const rows = await tx.query(
        `select s.id, s.report_kind, s.report, s.period, s.format, s.active, s.owner,
                s.next_run_at, s.last_run_at, s.paused_reason,
                case when s.report_kind = 'standard' then rd.title else sr.name end as report_name,
                ow.person_name as owner_name,
                (select count(*)::int from deedbox.schedule_recipient r where r.schedule = s.id) as recipients
           from deedbox.report_schedule s
           left join deedbox.report_definition rd on rd.id = s.report and s.report_kind = 'standard'
           left join deedbox.saved_report sr on sr.id = s.report and s.report_kind = 'saved'
           join deedbox.staff_member ow on ow.id = s.owner
          where $2 or s.owner = $1
          order by s.next_run_at`,
        [p.id, manageAll],
      )
      return { schedules: rows.rows, manageAll }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Targets & groups.
// ---------------------------------------------------------------------------

export async function targetsScreen(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const firmWide = await hasCapability(tx, p.id, 'report.firm_financial')
      const manage = await hasCapability(tx, p.id, 'settings.manage')
      const targets = await tx.query(
        `select t.subject_kind, t.subject, t.metric, t.amount, t.period_kind,
                t.period_start::text as period_start, t.period_end::text as period_end,
                case when t.subject_kind = 'staff' then s.person_name end as staff_name,
                case when t.subject_kind = 'group' then g.name end as group_name
           from deedbox.performance_target t
           left join deedbox.staff_member s on s.id = t.subject and t.subject_kind = 'staff'
           left join deedbox.staff_group g on g.id = t.subject and t.subject_kind = 'group'
          where t.deleted_at is null
            and ($2 or (t.subject_kind = 'staff' and t.subject = $1))
          order by t.subject_kind, t.subject, t.period_start desc`,
        [p.id, firmWide],
      )
      const staff = await tx.query(
        `select id, person_name from deedbox.staff_member where active order by id`,
      )
      const groups = await tx.query(
        `select g.id, g.name,
                (select count(*)::int from deedbox.staff_group_member m where m."group" = g.id) as members
           from deedbox.staff_group g where g.active and g.deleted_at is null order by g.name`,
      )
      return { targets: targets.rows, staff: staff.rows, groups: groups.rows, firmWide, manage }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Import wizard & batch screens.
// ---------------------------------------------------------------------------

export async function importScreens(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const batches = await tx.query(
        `select b.id, b.record_domain, b.mode, b.state, b.source_system, b.counts,
                b.started_at, b.finished_at, b.migration
           from deedbox.import_batch b
          order by b.id desc
          limit 100`,
      )
      const mappings = await tx.query(
        `select id, name, origin, source_format_key, record_type, active
           from deedbox.mapping_template
          order by origin, name`,
      )
      const migrations = await tx.query(
        `select id, source_system, started_at, completed_at, summary_artefact
           from deedbox.migration
          order by id desc`,
      )
      return { batches: batches.rows, mappings: mappings.rows, migrations: migrations.rows }
    },
    { readOnly: true },
  )
}

export async function importBatchDetail(p: Principal, batch: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const b = await tx.query(
        `select b.id, b.record_domain, b.mode, b.state, b.source_system, b.counts,
                b.report_artefact, b.started_at, b.finished_at, b.migration, b.mapping
           from deedbox.import_batch b where b.id = $1`,
        [batch],
      )
      if (b.rowCount === 0) throw new OperationRefused('not_found', 'import batch not found')
      const records = await tx.query(
        `select source_ref, disposition, message, target_type, target
           from deedbox.import_record where batch = $1 order by id`,
        [batch],
      )
      return { batch: b.rows[0], records: records.rows }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Integration keys screen & key detail.
// ---------------------------------------------------------------------------

export async function keysScreen(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await (async () => {
        if (!(await hasCapability(tx, p.id, 'keys.manage'))) {
          throw new OperationRefused('not_permitted', 'integration keys need keys.manage')
        }
      })()
      const keys = await tx.query(
        `select k.id, k.label, k.key_display, k.issued_at, k.last_used_at, k.revoked_at,
                k.rate_limit, k.test_mode, k.payload_versions, k.templates_read,
                s.person_name as issued_by_name
           from deedbox.integration_key k
           join deedbox.staff_member s on s.id = k.issued_by
          order by k.id desc`,
      )
      return keys.rows
    },
    { readOnly: true },
  )
}

export async function keyDetail(p: Principal, key: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      if (!(await hasCapability(tx, p.id, 'keys.manage'))) {
        throw new OperationRefused('not_permitted', 'integration keys need keys.manage')
      }
      const k = await tx.query(
        `select k.id, k.label, k.key_display, k.issued_at, k.last_used_at, k.revoked_at,
                k.rate_limit, k.test_mode, k.payload_versions, k.templates_read,
                s.person_name as issued_by_name
           from deedbox.integration_key k
           join deedbox.staff_member s on s.id = k.issued_by
          where k.id = $1`,
        [key],
      )
      if (k.rowCount === 0) throw new OperationRefused('not_found', 'integration key not found')
      const submissions = await tx.query(
        `select id, idempotency_key, outcome, created_type, created, received_at, original, test
           from deedbox.inbound_submission
          where key = $1
          order by id desc limit 100`,
        [key],
      )
      const activity = await tx.query(
        `select re.event_kind, re.occurred_at, re.detail
           from deedbox.register_entry re
          where re.event_kind in ('key.used','key.issued','key.revoked') and re.subject = $1
            and re.subject_type = 'integration_key'
          order by re.id desc limit 100`,
        [key],
      )
      // the intake API's per-key creation defaults (0026) + the select lists
      const defaults = await tx.query(
        `select office, responsible_lawyer, practice_area
           from deedbox.integration_key_defaults where key = $1`,
        [key],
      )
      const staff = await tx.query(
        `select id, person_name from deedbox.staff_member where active order by id`,
      )
      const offices = await tx.query(
        `select id, name from deedbox.office where active order by name`,
      )
      const practiceAreas = await tx.query(
        `select id, name from deedbox.practice_area where active order by name`,
      )
      return {
        key: k.rows[0],
        submissions: submissions.rows,
        activity: activity.rows,
        defaults: defaults.rows[0] ?? null,
        staff: staff.rows,
        offices: offices.rows,
        practiceAreas: practiceAreas.rows,
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Outbound message log.
// ---------------------------------------------------------------------------

export async function outboundLog(
  p: Principal,
  filters: { purpose?: string; state?: string } = {},
) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      // Visibility: administrator + accounts — gated on the closest
      // capability each of those roles uniquely holds (recorded choice;
      // matter-linked rows also surface on timelines under the predicate)
      if (
        !(await hasCapability(tx, p.id, 'security.administer')) &&
        !(await hasCapability(tx, p.id, 'money.manage_accounts'))
      ) {
        throw new OperationRefused('not_permitted', 'the outbound log is for administrators and accounts staff')
      }
      const rows = await tx.query(
        `select id, channel, recipient, purpose, state, queued_at, sent_at, failed_reason,
                related_type, related, rendered_artefact, retry_of
           from deedbox.outbound_message
          where ($1::text is null or purpose = $1)
            and ($2::text is null or state = $2)
          order by id desc
          limit 200`,
        [filters.purpose ?? null, filters.state ?? null],
      )
      const purposes = await tx.query(
        `select distinct purpose from deedbox.outbound_message order by purpose limit 50`,
      )
      return { rows: rows.rows, purposes: purposes.rows.map((x) => x.purpose as string) }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Report viewer context: the definition's schedulable flag plus the
// select lists its filter/schedule forms need. (The person's own devices &
// sessions read lives in lib/reads/security — the /account screen's.)
// ---------------------------------------------------------------------------

export async function reportViewerContext(p: Principal, key: string) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const def = await tx.query(
        `select schedulable from deedbox.report_definition where key = $1`,
        [key],
      )
      if (def.rowCount === 0) throw new OperationRefused('not_found', 'no report by that key')
      const staff = await tx.query(
        `select id, person_name from deedbox.staff_member where active order by id`,
      )
      const practiceAreas = await tx.query(
        `select id, name from deedbox.practice_area where active order by name`,
      )
      const offices = await tx.query(
        `select id, name from deedbox.office where active order by name`,
      )
      return {
        schedulable: Boolean(def.rows[0].schedulable),
        staff: staff.rows,
        practiceAreas: practiceAreas.rows,
        offices: offices.rows,
      }
    },
    { readOnly: true },
  )
}
