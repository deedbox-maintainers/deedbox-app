// Predicate-governed reads for the security & register screens.
// Matter-linked register entries pass the viewer's predicate by
// the established pattern: the matter join runs under row security, so an
// invisible matter's entries drop out of the stream; matterless entries
// stand on the capability gate alone.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability, requireCapability } from '@/lib/ops/shared'

export interface RegisterFilters {
  actorKind?: string
  actor?: number
  eventKind?: string
  namespace?: string
  from?: string
  to?: string
  subjectType?: string
  subject?: number
  matter?: number
  privilegedOnly?: boolean
  limit?: number
  before?: number // paging: entries with id below this
}

/** Register screen — the filterable stream. */
export async function registerStream(p: Principal, f: RegisterFilters = {}) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'register.read')
      const r = await tx.query(
        `select re.id, re.seq, re.occurred_at, re.actor_kind, re.actor, re.event_kind,
                re.subject_type, re.subject, re.matter, re.privileged, re.detail,
                re.reason, re.artefact,
                s.person_name as actor_name,
                dt.template_key, dt.timeline_kind
           from deedbox.register_entry re
           left join deedbox.matter m on m.id = re.matter
           left join deedbox.staff_member s on s.id = re.actor and re.actor_kind = 'staff'
           left join deedbox.event_display_template dt on dt.event_kind = re.event_kind
          where (re.matter is null or m.id is not null)
            and ($1::text is null or re.actor_kind = $1)
            and ($2::bigint is null or re.actor = $2)
            and ($3::text is null or re.event_kind = $3)
            and ($4::text is null or split_part(re.event_kind, '.', 1) = $4)
            and ($5::timestamptz is null or re.occurred_at >= $5)
            and ($6::timestamptz is null or re.occurred_at <= $6)
            and ($7::text is null or re.subject_type = $7)
            and ($8::bigint is null or re.subject = $8)
            and ($9::bigint is null or re.matter = $9)
            and (not $10::boolean or re.privileged)
            and ($11::bigint is null or re.id < $11)
          order by re.id desc
          limit $12`,
        [
          f.actorKind ?? null,
          f.actor ?? null,
          f.eventKind ?? null,
          f.namespace ?? null,
          f.from ?? null,
          f.to ?? null,
          f.subjectType ?? null,
          f.subject ?? null,
          f.matter ?? null,
          f.privilegedOnly ?? false,
          f.before ?? null,
          Math.min(f.limit ?? 100, 500),
        ],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

/** Sign-in history: signin.* + session.ended; own rows for everyone, all under security.administer. */
export async function signInHistory(
  p: Principal,
  opts: { allStaff?: boolean; limit?: number } = {},
) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const admin = await hasCapability(tx, p.id, 'security.administer')
      const all = opts.allStaff === true
      if (all && !admin) {
        throw new OperationRefused('not_permitted', 'firm-wide sign-in history needs security.administer')
      }
      const r = await tx.query(
        `select re.id, re.occurred_at, re.event_kind, re.actor_kind, re.actor,
                re.subject_type, re.subject, re.detail,
                s.person_name as actor_name
           from deedbox.register_entry re
           left join deedbox.staff_member s on s.id = re.actor and re.actor_kind = 'staff'
          where split_part(re.event_kind, '.', 1) = 'signin' or re.event_kind = 'session.ended'
          order by re.id desc limit $1`,
        [Math.min(opts.limit ?? 200, 500)],
      )
      if (all) return r.rows
      // own rows: entries the viewer acted, plus failures recorded against
      // them (subject staff_member = viewer; unknown-login failures carry
      // the system actor and subject 0, so they appear to administrators only)
      return r.rows.filter(
        (row) =>
          (row.actor_kind === 'staff' && row.actor === p.id) ||
          (row.subject_type === 'staff_member' && row.subject === p.id),
      )
    },
    { readOnly: true },
  )
}

/** My devices & sessions. */
export async function myDevicesAndSessions(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const devices = await tx.query(
        `select id, fingerprint, label, first_seen, last_seen, network_hint,
                trusted, trusted_at, trust_expires_at, revoked_at
           from deedbox.device
          where owner_kind = 'staff' and owner = $1
          order by last_seen desc`,
        [p.id],
      )
      const sessions = await tx.query(
        `select id, device, started_at, last_seen_at, step_up_passed, step_up_required,
                ended_at, end_reason
           from deedbox.session
          where principal_kind = 'staff' and principal = $1
          order by started_at desc limit 50`,
        [p.id],
      )
      return { devices: devices.rows, sessions: sessions.rows }
    },
    { readOnly: true },
  )
}

/** All sessions (admin). */
export async function allActiveSessions(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'session.terminate_others')
      const r = await tx.query(
        `select se.id, se.principal_kind, se.principal, se.device, se.started_at,
                se.last_seen_at, se.step_up_passed, se.step_up_required,
                s.person_name, d.label as device_label, d.fingerprint
           from deedbox.session se
           left join deedbox.staff_member s on s.id = se.principal and se.principal_kind = 'staff'
           left join deedbox.device d on d.id = se.device
          where se.ended_at is null
          order by se.last_seen_at desc`,
      )
      return r.rows
    },
    { readOnly: true },
  )
}

/** MFA enrolment view: staff in MFA-required roles not enrolled. */
export async function mfaEnrolmentGaps(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'security.administer')
      const policy = await tx.query(
        `select mfa_scope, mfa_roles from deedbox.auth_policy where firm = $1`,
        [p.firm],
      )
      const scope = policy.rows[0]?.mfa_scope ?? 'off'
      if (scope === 'off') return { scope, staff: [] }
      const r = await tx.query(
        `select s.id, s.person_name, s.login, r.name as role_name
           from deedbox.staff_member s join deedbox.role r on r.id = s.role
          where s.active and not s.mfa_enrolled
            and ($1 = 'all_users' or s.role = any($2::bigint[]))
          order by r.name, s.login`,
        [scope, (policy.rows[0]?.mfa_roles as number[] | null) ?? []],
      )
      return { scope, staff: r.rows }
    },
    { readOnly: true },
  )
}

/** Security policy screen: the policy in force + the four session settings. */
export async function securityPolicy(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'security.administer')
      const policy = await tx.query(
        `select mfa_scope, mfa_roles, step_up_on_unrecognised, step_up_email_fallback
           from deedbox.auth_policy where firm = $1`,
        [p.firm],
      )
      const settings = await tx.query(
        `select key, deedbox.current_setting_value(key) as value
           from deedbox.setting_definition
          where key in ('auth.session_idle_minutes','auth.session_absolute_hours',
                        'auth.device_trust_days','auth.step_up_freshness_minutes')`,
      )
      const roles = await tx.query(`select id, name from deedbox.role where active order by name`)
      const history = await tx.query(
        `select occurred_at, actor, detail from deedbox.register_entry
          where event_kind = 'auth_policy.changed' order by id desc limit 20`,
      )
      return {
        policy: policy.rows[0] ?? null,
        settings: Object.fromEntries(settings.rows.map((s) => [s.key, s.value])),
        roles: roles.rows,
        history: history.rows,
      }
    },
    { readOnly: true },
  )
}

/** Roles & capabilities: the matrix with safe-bounds metadata. */
export async function rolesMatrix(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'roles.manage')
      const roles = await tx.query(
        `select id, name, system_key, external, active from deedbox.role order by external, name`,
      )
      const caps = await tx.query(
        `select key, description, grantable_to_firm_roles, external_role_permitted,
                money_authorisation, admin_floor
           from deedbox.capability order by key`,
      )
      const grants = await tx.query(`select role, capability, scope from deedbox.role_capability`)
      return { roles: roles.rows, capabilities: caps.rows, grants: grants.rows }
    },
    { readOnly: true },
  )
}

/** Staff screen: list for all staff (names/offices); detail under roles.manage. */
export async function staffList(p: Principal, filter: { active?: boolean } = {}) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select s.id, s.person_name, s.login, s.email, s.active, s.mfa_enrolled,
                r.name as role_name, r.id as role, o.name as office_name, o.id as office
           from deedbox.staff_member s
           join deedbox.role r on r.id = s.role
           join deedbox.office o on o.id = s.office
          where ($1::boolean is null or s.active = $1)
          order by s.active desc, s.login`,
        [filter.active ?? null],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function staffDetail(p: Principal, staffId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'roles.manage')
      const s = await tx.query(
        `select s.id, s.person_name, s.login, s.email, s.active, s.mfa_enrolled, s.start_date,
                r.name as role_name, r.id as role, o.name as office_name, o.id as office,
                (select count(*)::int from deedbox.session se
                  where se.principal_kind = 'staff' and se.principal = s.id and se.ended_at is null)
                  as active_sessions,
                (select count(*)::int from deedbox.mfa_credential mc
                  where mc.staff = s.id and mc.revoked_at is null) as factors
           from deedbox.staff_member s
           join deedbox.role r on r.id = s.role
           join deedbox.office o on o.id = s.office
          where s.id = $1`,
        [staffId],
      )
      if (s.rowCount === 0) throw new OperationRefused('not_found', 'no such staff member')
      const roles = await tx.query(`select id, name from deedbox.role where active and not external order by name`)
      return { staff: s.rows[0], roles: roles.rows }
    },
    { readOnly: true },
  )
}

const SOFT_DELETED_SOURCES: { entityType: string; table: string; labelSql: string }[] = [
  { entityType: 'note', table: 'note', labelSql: `left(t.body, 80)` },
  { entityType: 'task', table: 'task', labelSql: `t.title` },
  { entityType: 'key_date', table: 'key_date', labelSql: `t.title` },
  { entityType: 'unbilled_time_entry', table: 'time_entry', labelSql: `left(t.narrative, 80)` },
  { entityType: 'unbilled_disbursement', table: 'disbursement', labelSql: `left(t.description, 80)` },
  { entityType: 'intake_record', table: 'intake_record', labelSql: `left(t.about, 80)` },
  { entityType: 'saved_report', table: 'saved_report', labelSql: `t.name` },
  { entityType: 'contact_point', table: 'contact_point', labelSql: `t.value` },
  { entityType: 'postal_address', table: 'postal_address', labelSql: `''` },
  { entityType: 'matter_party', table: 'matter_party', labelSql: `''` },
  { entityType: 'matter_relation', table: 'matter_relation', labelSql: `''` },
  { entityType: 'party_link', table: 'party_link', labelSql: `''` },
]

/** Deleted-records restore: every soft-deleted row with its remaining window. */
export async function deletedRecords(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'deleted.restore')
      const fallback = await tx.query(
        `select (deedbox.current_setting_value('softdelete.retention_days') #>> '{}')::int as days`,
      )
      const fallbackDays = (fallback.rows[0].days as number) ?? 90
      const out: {
        entityType: string
        id: number
        label: string
        deletedAt: string
        deletedBy: number | null
        daysRemaining: number
      }[] = []
      for (const src of SOFT_DELETED_SOURCES) {
        const policy = await tx.query(
          `select restore_window_days from deedbox.deletion_policy where entity_type = $1 and mode = 'soft_delete'`,
          [src.entityType],
        )
        if (policy.rowCount === 0) continue
        const windowDays = (policy.rows[0].restore_window_days as number | null) ?? fallbackDays
        const r = await tx.query(
          `select t.id, ${src.labelSql} as label, t.deleted_at, t.deleted_by,
                  ceil(extract(epoch from (t.deleted_at + make_interval(days => $1) - now())) / 86400)::int
                    as days_remaining
             from deedbox.${src.table} t
            where t.deleted_at is not null
            order by t.deleted_at desc limit 200`,
          [windowDays],
        )
        for (const row of r.rows) {
          out.push({
            entityType: src.entityType,
            id: row.id as number,
            label: (row.label as string) ?? '',
            deletedAt: String(row.deleted_at),
            deletedBy: row.deleted_by as number | null,
            daysRemaining: row.days_remaining as number,
          })
        }
      }
      return out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1))
    },
    { readOnly: true },
  )
}

/** Anomaly alerts: unacknowledged first. */
export async function anomalyAlerts(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'security.administer')
      const r = await tx.query(
        `select a.id, a.summary, a.raised_at, a.acknowledged_by, a.acknowledged_at,
                a.triggering_register_entries, r.key as rule_key, r.threshold
           from deedbox.anomaly_alert a join deedbox.anomaly_rule r on r.id = a.rule
          order by (a.acknowledged_at is null) desc, a.raised_at desc limit 200`,
      )
      return r.rows
    },
    { readOnly: true },
  )
}

/** Examiner grants with per-grant read activity. */
export async function examinerGrantsScreen(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const mayView =
        (await hasCapability(tx, p.id, 'security.administer')) ||
        (await hasCapability(tx, p.id, 'money.grant_examiner'))
      if (!mayView) {
        throw new OperationRefused(
          'not_permitted',
          'examiner grants need security.administer or money.grant_examiner',
        )
      }
      const r = await tx.query(
        `select g.id, g.examiner_name, g.login, g.starts_at, g.expires_at,
                g.period_start, g.period_end, g.revoked_at,
                (select count(*)::int from deedbox.register_entry re
                  where re.event_kind in ('examiner.read') and re.actor_kind = 'examiner'
                    and re.actor = g.id) as reads,
                (select count(*)::int from deedbox.session se
                  where se.principal_kind = 'examiner' and se.principal = g.id
                    and se.ended_at is null) as active_sessions
           from deedbox.examiner_grant g
          order by g.starts_at desc`,
      )
      return r.rows
    },
    { readOnly: true },
  )
}

/** Export history: export.performed projection; own rows for everyone. */
export async function exportHistory(p: Principal, opts: { limit?: number } = {}) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const admin = await hasCapability(tx, p.id, 'security.administer')
      const r = await tx.query(
        `select re.id, re.occurred_at, re.actor_kind, re.actor, re.detail, re.artefact,
                s.person_name as actor_name
           from deedbox.register_entry re
           left join deedbox.staff_member s on s.id = re.actor and re.actor_kind = 'staff'
          where re.event_kind = 'export.performed'
            and ($1::boolean or (re.actor_kind = 'staff' and re.actor = $2))
          order by re.id desc limit $3`,
        [admin, p.id, Math.min(opts.limit ?? 100, 500)],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

/** Resilience screen: verification runs + control documents + objectives. */
export async function resilienceScreen(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'security.administer')
      const events = await tx.query(
        `select id, kind, environment, started_at, completed_at, outcome,
                measured_recovery_point_minutes, measured_recovery_minutes, artefact, notes
           from deedbox.resilience_event order by started_at desc limit 50`,
      )
      const docs = await tx.query(
        `select key, version, artefact, effective_from from deedbox.control_document
          order by key, effective_from desc`,
      )
      return { events: events.rows, documents: docs.rows }
    },
    { readOnly: true },
  )
}
