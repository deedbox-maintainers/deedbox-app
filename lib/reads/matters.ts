// Predicate-governed reads for the matters/parties screens (seventeen
// surfaces). Every read runs in a read-only withPrincipal transaction: row
// security drops restricted and out-of-scope matters from every list, join
// and count, so a tile and its drill-down can never disagree. Where a
// surface renders restricted-matter content to a cleared viewer, the
// disclosure is recorded in its own committed transaction BEFORE the data is
// returned (recordRestrictedViews) — a failed recording withholds the
// content by throwing.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability, requireCapability, settingText, settingBool } from '@/lib/ops/shared'
import { readMembership, type Membership } from '@/lib/ops/matters/restriction'
import { closePositionInTx, type FinancialPosition, type ConditionEvaluation } from '@/lib/ops/matters/matterLifecycle'
import { recordRestrictedViews, effectiveViewersInTx } from '@/lib/ops/security'

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export interface PartyListRow {
  id: number
  kind: string
  displayName: string
  primaryPhone: string | null
  primaryEmail: string | null
  matchedName: string | null
}

/** Party list / picker: search-as-you-type over the match keys; merged
 * and soft-deleted absent. An empty query lists recent parties. */
export async function partyList(
  p: Principal,
  opts: { q?: string; limit?: number } = {},
): Promise<PartyListRow[]> {
  requireStaff(p)
  const q = opts.q?.trim() ?? ''
  const limit = Math.min(opts.limit ?? 50, 200)
  return withPrincipal(
    p,
    async (tx) => {
      if (q === '') {
        const r = await tx.query(
          `select id, kind, display_name, primary_phone, primary_email
             from deedbox.party
            where state = 'active' and deleted_at is null
            order by id desc limit $1`,
          [limit],
        )
        return r.rows.map(rowToPartyList)
      }
      // Match keys carry every name of every kind, folded + phonetic; a
      // plain substring match keeps short queries honest and fast.
      const r = await tx.query(
        `select distinct on (pt.id)
                pt.id, pt.kind, pt.display_name, pt.primary_phone, pt.primary_email,
                pn.full_name as matched_name
           from deedbox.party_match_key mk
           join deedbox.party pt on pt.id = mk.party
           left join deedbox.party_name pn on pn.id = mk.source_name
          where pt.state = 'active' and pt.deleted_at is null
            and (mk.name_key like '%' || deedbox.fold_name($1) || '%'
                 or extensions.similarity(mk.name_key, deedbox.fold_name($1)) >= 0.4
                 or mk.phone_key = regexp_replace($1, '\\D', '', 'g')
                 or mk.email_key = lower($1))
          order by pt.id desc
          limit $2`,
        [q, limit],
      )
      return r.rows.map(rowToPartyList)
    },
    { readOnly: true },
  )
}

function rowToPartyList(r: Record<string, unknown>): PartyListRow {
  return {
    id: r.id as number,
    kind: r.kind as string,
    displayName: r.display_name as string,
    primaryPhone: (r.primary_phone as string) ?? null,
    primaryEmail: (r.primary_email as string) ?? null,
    matchedName: (r.matched_name as string) ?? null,
  }
}

export interface PartyProfile {
  party: {
    id: number
    kind: string
    displayName: string
    state: string
    mergedInto: number | null
    mergedIntoName: string | null
    primaryPhone: string | null
    primaryEmail: string | null
    notes: string | null
    portalLogin: string | null
  }
  names: { id: number; kind: string; fullName: string }[]
  contacts: { id: number; kind: string; value: string; label: string | null; isPrimary: boolean }[]
  addresses: {
    id: number
    kind: string
    lines: string | null
    locality: string | null
    region: string | null
    postcode: string | null
    country: string | null
    current: boolean
  }[]
  links: { id: number; direction: 'out' | 'in'; otherParty: number; otherName: string; kindLabel: string; note: string | null }[]
  customFields: { key: string; label: string; value: unknown }[]
  /** Matters the viewer may see, with this party's capacity on each. */
  matters: { id: number; matterNumber: string; title: string; status: string; capacity: string }[]
  notes: { id: number; body: string; notedAt: string }[]
  /** Merges into this party (as survivor). */
  absorbed: { merge: number; absorbed: number; absorbedName: string; performedAt: string; undoneAt: string | null }[]
}

/** Party profile. Merged parties still render (history), with the
 * survivor line; every picker elsewhere excludes them. */
export async function partyProfile(p: Principal, partyId: number): Promise<PartyProfile> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const party = await tx.query(
        `select pt.id, pt.kind, pt.display_name, pt.state, pt.merged_into, pt.primary_phone,
                pt.primary_email, pt.notes, pt.portal_login, sv.display_name as merged_into_name
           from deedbox.party pt
           left join deedbox.party sv on sv.id = pt.merged_into
          where pt.id = $1 and pt.deleted_at is null`,
        [partyId],
      )
      if (party.rowCount === 0) throw new OperationRefused('not_found', 'party not found')
      const names = await tx.query(
        `select id, name_kind, full_name from deedbox.party_name where party = $1 order by id`,
        [partyId],
      )
      const contacts = await tx.query(
        `select id, kind, value, label, is_primary from deedbox.contact_point
          where party = $1 and deleted_at is null order by kind, is_primary desc, id`,
        [partyId],
      )
      const addresses = await tx.query(
        `select id, kind, lines, locality, region, postcode, country, current
           from deedbox.postal_address where party = $1 and deleted_at is null
          order by current desc, id`,
        [partyId],
      )
      const links = await tx.query(
        `select l.id, l.note,
                case when l.from_party = $1 then 'out' else 'in' end as direction,
                case when l.from_party = $1 then l.to_party else l.from_party end as other_party,
                op.display_name as other_name, ci.label as kind_label
           from deedbox.party_link l
           join deedbox.party op on op.id = case when l.from_party = $1 then l.to_party else l.from_party end
           join deedbox.choice_item ci on ci.id = l.link_kind
          where (l.from_party = $1 or l.to_party = $1) and l.deleted_at is null
          order by l.id`,
        [partyId],
      )
      const fields = await tx.query(
        `select d.key, d.label, v.text_value, v.number_value, v.date_value, v.party_value,
                ci.label as choice_label
           from deedbox.custom_field_value v
           join deedbox.custom_field_definition d on d.id = v.definition
           left join deedbox.choice_item ci on ci.id = v.choice_value
          where v.owner_type = 'party' and v.owner = $1
          order by d.key`,
        [partyId],
      )
      // The viewer's predicate governs the matter join: invisible matters
      // drop out (the profile shows only what the viewer may see).
      const matters = await tx.query(
        `select m.id, m.matter_number, m.title, m.status, ci.label as capacity
           from deedbox.matter_party mp
           join deedbox.matter m on m.id = mp.matter
           join deedbox.choice_item ci on ci.id = mp.capacity
          where mp.party = $1 and mp.deleted_at is null
          order by m.id desc`,
        [partyId],
      )
      const notes = await tx.query(
        `select id, body, noted_at from deedbox.note
          where owner_type = 'party' and owner = $1 and deleted_at is null
          order by noted_at desc`,
        [partyId],
      )
      const absorbed = await tx.query(
        `select pm.id, pm.absorbed, pm.performed_at, pm.undone_at,
                (pm.absorbed_snapshot ->> 'display_name') as absorbed_name
           from deedbox.party_merge pm
          where pm.survivor = $1
          order by pm.performed_at desc`,
        [partyId],
      )
      const pr = party.rows[0]
      return {
        party: {
          id: pr.id as number,
          kind: pr.kind as string,
          displayName: pr.display_name as string,
          state: pr.state as string,
          mergedInto: (pr.merged_into as number) ?? null,
          mergedIntoName: (pr.merged_into_name as string) ?? null,
          primaryPhone: (pr.primary_phone as string) ?? null,
          primaryEmail: (pr.primary_email as string) ?? null,
          notes: (pr.notes as string) ?? null,
          portalLogin: (pr.portal_login as string) ?? null,
        },
        names: names.rows.map((r) => ({
          id: r.id as number,
          kind: r.name_kind as string,
          fullName: r.full_name as string,
        })),
        contacts: contacts.rows.map((r) => ({
          id: r.id as number,
          kind: r.kind as string,
          value: r.value as string,
          label: (r.label as string) ?? null,
          isPrimary: r.is_primary as boolean,
        })),
        addresses: addresses.rows.map((r) => ({
          id: r.id as number,
          kind: r.kind as string,
          lines: (r.lines as string) ?? null,
          locality: (r.locality as string) ?? null,
          region: (r.region as string) ?? null,
          postcode: (r.postcode as string) ?? null,
          country: (r.country as string) ?? null,
          current: r.current as boolean,
        })),
        links: links.rows.map((r) => ({
          id: r.id as number,
          direction: r.direction as 'out' | 'in',
          otherParty: r.other_party as number,
          otherName: r.other_name as string,
          kindLabel: r.kind_label as string,
          note: (r.note as string) ?? null,
        })),
        customFields: fields.rows.map((r) => ({
          key: r.key as string,
          label: r.label as string,
          value:
            r.text_value ?? r.number_value ?? r.date_value ?? r.choice_label ?? r.party_value ?? null,
        })),
        matters: matters.rows.map((r) => ({
          id: r.id as number,
          matterNumber: r.matter_number as string,
          title: r.title as string,
          status: r.status as string,
          capacity: r.capacity as string,
        })),
        notes: notes.rows.map((r) => ({
          id: r.id as number,
          body: r.body as string,
          notedAt: String(r.noted_at),
        })),
        absorbed: absorbed.rows.map((r) => ({
          merge: r.id as number,
          absorbed: r.absorbed as number,
          absorbedName: (r.absorbed_name as string) ?? String(r.absorbed),
          performedAt: String(r.performed_at),
          undoneAt: r.undone_at ? String(r.undone_at) : null,
        })),
      }
    },
    { readOnly: true },
  )
}

/** Deferred duplicate review queue: unreviewed integration decisions,
 * test-flagged rows excluded from every business surface. */
export async function duplicateReviewQueue(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select dd.id, dd.created_entity_type, dd.created_entity, dd.candidates_shown,
                dd.decided_at,
                case dd.created_entity_type
                  when 'party' then (select display_name from deedbox.party where id = dd.created_entity)
                  else (select left(about, 80) from deedbox.intake_record where id = dd.created_entity)
                end as created_label
           from deedbox.duplicate_decision dd
          where dd.decision_mode = 'integration_deferred'
            and dd.reviewed_at is null and not dd.test
          order by dd.decided_at`,
      )
      return r.rows.map((row) => ({
        id: row.id as number,
        createdEntityType: row.created_entity_type as string,
        createdEntity: row.created_entity as number,
        createdLabel: (row.created_label as string) ?? '',
        candidatesShown: row.candidates_shown,
        decidedAt: String(row.decided_at),
      }))
    },
    { readOnly: true },
  )
}

/** Merge screen support: recent merges still inside the undo window. */
export async function openMerges(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const windowDays = Number(
        (await tx.query(
          `select (deedbox.current_setting_value('undo.bulk_window_days') #>> '{}')::int as d`,
        )).rows[0].d ?? 7,
      )
      const r = await tx.query(
        `select pm.id, pm.survivor, pm.absorbed, pm.performed_at,
                sv.display_name as survivor_name,
                (pm.absorbed_snapshot ->> 'display_name') as absorbed_name
           from deedbox.party_merge pm
           join deedbox.party sv on sv.id = pm.survivor
          where pm.undone_at is null
            and pm.performed_at > now() - make_interval(days => $1)
          order by pm.performed_at desc limit 20`,
        [windowDays],
      )
      return r.rows.map((row) => ({
        merge: row.id as number,
        survivor: row.survivor as number,
        survivorName: row.survivor_name as string,
        absorbed: row.absorbed as number,
        absorbedName: (row.absorbed_name as string) ?? String(row.absorbed),
        performedAt: String(row.performed_at),
      }))
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Matters
// ---------------------------------------------------------------------------

export interface MatterFilters {
  status?: string
  office?: number
  practiceArea?: number
  lawyer?: number
  client?: number
  q?: string
  limit?: number
}

export interface MatterListRow {
  id: number
  matterNumber: string
  title: string
  status: string
  clientName: string
  lawyerName: string
  officeName: string
  areaName: string
  restricted: boolean
  openedDate: string
  unbilled: number | null
  outstanding: number | null
  heldAvailable: number | null
}

/** Matter list with financials (position figures from the display cache —
 * display only, may lag the register frontier). Restricted matters a cleared
 * viewer receives are recorded as disclosures, surface matter_list. */
export async function matterList(p: Principal, f: MatterFilters = {}): Promise<MatterListRow[]> {
  requireStaff(p)
  const rows = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select m.id, m.matter_number, m.title, m.status, m.restricted, m.opened_date,
                cp.display_name as client_name,
                s.person_name as lawyer_name,
                o.name as office_name, pa.name as area_name,
                pc.unbilled_value, pc.outstanding_value, pc.held_available
           from deedbox.matter m
           join deedbox.party cp on cp.id = m.client_party
           join deedbox.staff_member s on s.id = m.responsible_lawyer
           join deedbox.office o on o.id = m.office
           join deedbox.practice_area pa on pa.id = m.practice_area
           left join deedbox.matter_position_cache pc on pc.matter = m.id
          where ($1::text is null or m.status = $1)
            and ($2::bigint is null or m.office = $2)
            and ($3::bigint is null or m.practice_area = $3)
            and ($4::bigint is null or m.responsible_lawyer = $4)
            and ($5::bigint is null or m.client_party = $5)
            and ($6::text is null or m.matter_number ilike '%' || $6 || '%'
                 or m.title ilike '%' || $6 || '%'
                 or m.prior_reference ilike '%' || $6 || '%'
                 or cp.display_name ilike '%' || $6 || '%')
          order by m.id desc
          limit $7`,
        [
          f.status ?? null,
          f.office ?? null,
          f.practiceArea ?? null,
          f.lawyer ?? null,
          f.client ?? null,
          f.q?.trim() || null,
          Math.min(f.limit ?? 100, 500),
        ],
      )
      return r.rows
    },
    { readOnly: true },
  )
  await recordRestrictedViews(
    p,
    rows.filter((r) => r.restricted === true).map((r) => r.id as number),
    'matter_list',
  )
  return rows.map((r) => ({
    id: r.id as number,
    matterNumber: r.matter_number as string,
    title: r.title as string,
    status: r.status as string,
    clientName: r.client_name as string,
    lawyerName: personNameText(r.lawyer_name),
    officeName: r.office_name as string,
    areaName: r.area_name as string,
    restricted: r.restricted as boolean,
    openedDate: String(r.opened_date),
    unbilled: r.unbilled_value === null || r.unbilled_value === undefined ? null : Number(r.unbilled_value),
    outstanding: r.outstanding_value === null || r.outstanding_value === undefined ? null : Number(r.outstanding_value),
    heldAvailable: r.held_available === null || r.held_available === undefined ? null : Number(r.held_available),
  }))
}

function personNameText(v: unknown): string {
  const p = v as { given?: string; family?: string } | null
  if (!p) return ''
  return [p.given, p.family].filter(Boolean).join(' ')
}

/** Filter dropdown data for the matter list and creation screens. */
export async function matterFilterOptions(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const offices = await tx.query(`select id, name from deedbox.office order by name`)
      const areas = await tx.query(
        `select id, name, active from deedbox.practice_area order by active desc, name`,
      )
      const lawyers = await tx.query(
        `select id, person_name from deedbox.staff_member where active order by login`,
      )
      const capacities = await tx.query(
        `select ci.id, ci.label from deedbox.choice_item ci
           join deedbox.choice_list cl on cl.id = ci.list
          where cl.purpose_key = 'matter_party_capacities' and ci.active
          order by ci.position`,
      )
      const relationLabels = await tx.query(
        `select ci.id, ci.label from deedbox.choice_item ci
           join deedbox.choice_list cl on cl.id = ci.list
          where cl.purpose_key = 'matter_relation_labels' and ci.active
          order by ci.position`,
      )
      const linkKinds = await tx.query(
        `select ci.id, ci.label from deedbox.choice_item ci
           join deedbox.choice_list cl on cl.id = ci.list
          where cl.purpose_key = 'party_link_kinds' and ci.active
          order by ci.position`,
      )
      const outcomes = await tx.query(
        `select ci.id, ci.label from deedbox.choice_item ci
           join deedbox.choice_list cl on cl.id = ci.list
          where cl.purpose_key = 'intake_outcomes' and ci.active
          order by ci.position`,
      )
      return {
        offices: offices.rows as { id: number; name: string }[],
        areas: areas.rows as { id: number; name: string; active: boolean }[],
        lawyers: lawyers.rows.map((r) => ({ id: r.id as number, name: personNameText(r.person_name) })),
        capacities: capacities.rows as { id: number; label: string }[],
        relationLabels: relationLabels.rows as { id: number; label: string }[],
        linkKinds: linkKinds.rows as { id: number; label: string }[],
        intakeOutcomes: outcomes.rows as { id: number; label: string }[],
      }
    },
    { readOnly: true },
  )
}

export interface MatterHub {
  matter: {
    id: number
    matterNumber: string
    title: string
    status: string
    restricted: boolean
    billingHold: boolean
    jurisdiction: string | null
    openedDate: string
    closedDate: string | null
    summary: string | null
    originNote: string | null
    priorReference: string | null
    client: { id: number; name: string }
    lawyer: { id: number; name: string }
    office: { id: number; name: string }
    area: { id: number; name: string }
  }
  /** The display cache — display only; null when the cache has no row yet. */
  position: { unbilled: number; outstanding: number; heldAvailable: number } | null
  parties: { id: number; party: number; name: string; capacity: string; portalAccess: boolean; merged: boolean }[]
  staffing: { id: number; staff: number; name: string; role: string; fromAt: string; toAt: string | null }[]
  relations: { id: number; farMatter: number | null; farNumber: string | null; farTitle: string | null; label: string; visible: boolean }[]
  customFields: { key: string; label: string; value: unknown }[]
  notes: { id: number; body: string; notedAt: string; authorName: string | null }[]
  timeline: {
    id: number
    occurredAt: string
    eventKind: string
    timelineKind: string | null
    actorName: string
    reason: string | null
    detail: unknown
  }[]
  pendingCloseRequest: { id: number; requestedBy: number; requesterName: string } | null
}

/** The matter hub. Opening a restricted matter is a recorded disclosure
 * (surface matter_profile) — recorded before the data is returned. */
export async function matterHub(p: Principal, matterId: number): Promise<MatterHub> {
  requireStaff(p)
  const hub = await withPrincipal(
    p,
    async (tx) => {
      const m = await tx.query(
        `select m.id, m.matter_number, m.title, m.status, m.restricted, m.billing_hold,
                m.jurisdiction, m.opened_date, m.closed_date, m.summary, m.origin_note,
                m.prior_reference,
                m.client_party, cp.display_name as client_name,
                m.responsible_lawyer, s.person_name as lawyer_name,
                m.office, o.name as office_name,
                m.practice_area, pa.name as area_name
           from deedbox.matter m
           join deedbox.party cp on cp.id = m.client_party
           join deedbox.staff_member s on s.id = m.responsible_lawyer
           join deedbox.office o on o.id = m.office
           join deedbox.practice_area pa on pa.id = m.practice_area
          where m.id = $1`,
        [matterId],
      )
      if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
      const cache = await tx.query(
        `select unbilled_value, outstanding_value, held_available
           from deedbox.matter_position_cache where matter = $1`,
        [matterId],
      )
      const parties = await tx.query(
        `select mp.id, mp.party, mp.portal_access, pt.display_name, pt.state, ci.label as capacity
           from deedbox.matter_party mp
           join deedbox.party pt on pt.id = mp.party
           join deedbox.choice_item ci on ci.id = mp.capacity
          where mp.matter = $1 and mp.deleted_at is null
          order by mp.id`,
        [matterId],
      )
      const staffing = await tx.query(
        `select ms.id, ms.staff, ms.role_on_matter, ms.from_at, ms.to_at, s.person_name
           from deedbox.matter_staffing ms
           join deedbox.staff_member s on s.id = ms.staff
          where ms.matter = $1
          order by (ms.to_at is null) desc, ms.from_at desc`,
        [matterId],
      )
      // The far side rides the viewer's predicate: an invisible far matter
      // leaves its join fields null and renders masked.
      const relations = await tx.query(
        `select r.id, ci.label,
                case when r.matter_a = $1 then r.matter_b else r.matter_a end as far_matter,
                fm.matter_number as far_number, fm.title as far_title
           from deedbox.matter_relation r
           join deedbox.choice_item ci on ci.id = r.label
           left join deedbox.matter fm
             on fm.id = case when r.matter_a = $1 then r.matter_b else r.matter_a end
          where (r.matter_a = $1 or r.matter_b = $1) and r.deleted_at is null
          order by r.id`,
        [matterId],
      )
      const fields = await tx.query(
        `select d.key, d.label, v.text_value, v.number_value, v.date_value, v.party_value,
                ci.label as choice_label
           from deedbox.custom_field_value v
           join deedbox.custom_field_definition d on d.id = v.definition
           left join deedbox.choice_item ci on ci.id = v.choice_value
          where v.owner_type = 'matter' and v.owner = $1
          order by d.key`,
        [matterId],
      )
      const notes = await tx.query(
        `select n.id, n.body, n.noted_at, s.person_name as author_name
           from deedbox.note n
           left join deedbox.staff_member s on s.id = n.author
          where n.owner_type = 'matter' and n.owner = $1 and n.deleted_at is null
          order by n.noted_at desc`,
        [matterId],
      )
      const timeline = await tx.query(
        `select re.id, re.occurred_at, re.event_kind, re.reason, re.detail,
                dt.timeline_kind, s.person_name as actor_name, re.actor_kind
           from deedbox.register_entry re
           join deedbox.register_event_kind ek on ek.kind = re.event_kind
           left join deedbox.event_display_template dt on dt.event_kind = re.event_kind
           left join deedbox.staff_member s on s.id = re.actor and re.actor_kind = 'staff'
          where re.matter = $1 and ek.timeline_eligible
          order by re.id desc limit 200`,
        [matterId],
      )
      const pendingReq = await tx.query(
        `select r.id, r.requested_by, s.person_name
           from deedbox.matter_close_request r
           join deedbox.staff_member s on s.id = r.requested_by
          where r.matter = $1 and r.state = 'pending'`,
        [matterId],
      )
      const mr = m.rows[0]
      return {
        matter: {
          id: mr.id as number,
          matterNumber: mr.matter_number as string,
          title: mr.title as string,
          status: mr.status as string,
          restricted: mr.restricted as boolean,
          billingHold: mr.billing_hold as boolean,
          jurisdiction: (mr.jurisdiction as string) ?? null,
          openedDate: String(mr.opened_date),
          closedDate: mr.closed_date ? String(mr.closed_date) : null,
          summary: (mr.summary as string) ?? null,
          originNote: (mr.origin_note as string) ?? null,
          priorReference: (mr.prior_reference as string) ?? null,
          client: { id: mr.client_party as number, name: mr.client_name as string },
          lawyer: { id: mr.responsible_lawyer as number, name: personNameText(mr.lawyer_name) },
          office: { id: mr.office as number, name: mr.office_name as string },
          area: { id: mr.practice_area as number, name: mr.area_name as string },
        },
        position:
          cache.rowCount === 0
            ? null
            : {
                unbilled: Number(cache.rows[0].unbilled_value),
                outstanding: Number(cache.rows[0].outstanding_value),
                heldAvailable: Number(cache.rows[0].held_available),
              },
        parties: parties.rows.map((r) => ({
          id: r.id as number,
          party: r.party as number,
          name: r.display_name as string,
          capacity: r.capacity as string,
          portalAccess: r.portal_access as boolean,
          merged: r.state === 'merged',
        })),
        staffing: staffing.rows.map((r) => ({
          id: r.id as number,
          staff: r.staff as number,
          name: personNameText(r.person_name),
          role: r.role_on_matter as string,
          fromAt: String(r.from_at),
          toAt: r.to_at ? String(r.to_at) : null,
        })),
        relations: relations.rows.map((r) => ({
          id: r.id as number,
          farMatter: (r.far_number ? (r.far_matter as number) : null),
          farNumber: (r.far_number as string) ?? null,
          farTitle: (r.far_title as string) ?? null,
          label: r.label as string,
          visible: r.far_number !== null,
        })),
        customFields: fields.rows.map((r) => ({
          key: r.key as string,
          label: r.label as string,
          value:
            r.text_value ?? r.number_value ?? r.date_value ?? r.choice_label ?? r.party_value ?? null,
        })),
        notes: notes.rows.map((r) => ({
          id: r.id as number,
          body: r.body as string,
          notedAt: String(r.noted_at),
          authorName: r.author_name ? personNameText(r.author_name) : null,
        })),
        timeline: timeline.rows.map((r) => ({
          id: r.id as number,
          occurredAt: String(r.occurred_at),
          eventKind: r.event_kind as string,
          timelineKind: (r.timeline_kind as string) ?? null,
          actorName:
            r.actor_kind === 'staff' ? personNameText(r.actor_name) : (r.actor_kind as string),
          reason: (r.reason as string) ?? null,
          detail: r.detail,
        })),
        pendingCloseRequest:
          pendingReq.rowCount === 0
            ? null
            : {
                id: pendingReq.rows[0].id as number,
                requestedBy: pendingReq.rows[0].requested_by as number,
                requesterName: personNameText(pendingReq.rows[0].person_name),
              },
      }
    },
    { readOnly: true },
  )
  if (hub.matter.restricted) {
    await recordRestrictedViews(p, [matterId], 'matter_profile')
  }
  return hub
}

/** Close screen: the live position computed fresh from the journals
 * (never the cache), each condition with its setting badge, the approval
 * setting, and any pending request. */
export async function closeScreen(p: Principal, matterId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const m = await tx.query(
        `select id, matter_number, title, status from deedbox.matter where id = $1`,
        [matterId],
      )
      if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
      const { position, evaluation, refusals } = await closePositionInTx(tx, matterId)
      const requiresApproval = await settingBool(tx, 'matter.close_requires_approval')
      const pending = await tx.query(
        `select r.id, r.requested_by, r.state, r.financial_position, r.condition_evaluation,
                s.person_name as requester_name
           from deedbox.matter_close_request r
           join deedbox.staff_member s on s.id = r.requested_by
          where r.matter = $1 and r.state = 'pending'`,
        [matterId],
      )
      return {
        matter: {
          id: m.rows[0].id as number,
          matterNumber: m.rows[0].matter_number as string,
          title: m.rows[0].title as string,
          status: m.rows[0].status as string,
        },
        position: position as FinancialPosition,
        evaluation: evaluation as ConditionEvaluation,
        refusals,
        requiresApproval,
        pendingRequest:
          pending.rowCount === 0
            ? null
            : {
                id: pending.rows[0].id as number,
                requestedBy: pending.rows[0].requested_by as number,
                requesterName: personNameText(pending.rows[0].requester_name),
              },
      }
    },
    { readOnly: true },
  )
}

/** Close approval queue: pending requests, own requests flagged
 * unapprovable. Visible to matter.close holders. */
export async function closeApprovalQueue(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'matter.close')
      const r = await tx.query(
        `select r.id, r.matter, r.requested_by, r.financial_position, r.condition_evaluation,
                r.state, m.matter_number, m.title, s.person_name as requester_name
           from deedbox.matter_close_request r
           join deedbox.matter m on m.id = r.matter
           join deedbox.staff_member s on s.id = r.requested_by
          where r.state = 'pending'
          order by r.id`,
      )
      return r.rows.map((row) => ({
        id: row.id as number,
        matter: row.matter as number,
        matterNumber: row.matter_number as string,
        title: row.title as string,
        requestedBy: row.requested_by as number,
        requesterName: personNameText(row.requester_name),
        own: row.requested_by === p.id,
        position: row.financial_position as FinancialPosition,
        evaluation: row.condition_evaluation as ConditionEvaluation,
      }))
    },
    { readOnly: true },
  )
}

/** Restriction panel: membership, resolved effective viewers, and the
 * change form's context. restriction.manage only; every open of a restricted
 * matter's panel is a recorded disclosure (surface restriction_panel). */
export async function restrictionPanel(p: Principal, matterId: number) {
  requireStaff(p)
  const data = await withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'restriction.manage')
      const m = await tx.query(
        `select id, matter_number, title, restricted, office, responsible_lawyer
           from deedbox.matter where id = $1`,
        [matterId],
      )
      if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
      const membership: Membership = await readMembership(tx, matterId)
      const effective = await effectiveViewersInTx(tx, {
        id: matterId,
        office: m.rows[0].office as number,
        responsible_lawyer: m.rows[0].responsible_lawyer as number,
      })
      const staff = await tx.query(
        `select id, person_name from deedbox.staff_member where active order by login`,
      )
      const roles = await tx.query(
        `select id, name from deedbox.role where active and not external order by name`,
      )
      return {
        matter: {
          id: m.rows[0].id as number,
          matterNumber: m.rows[0].matter_number as string,
          title: m.rows[0].title as string,
          restricted: m.rows[0].restricted as boolean,
        },
        membership,
        effectiveViewers: effective.viewers,
        staffOptions: staff.rows.map((r) => ({ id: r.id as number, name: personNameText(r.person_name) })),
        roleOptions: roles.rows as { id: number; name: string }[],
      }
    },
    { readOnly: true },
  )
  if (data.matter.restricted) {
    await recordRestrictedViews(p, [matterId], 'restriction_panel')
  }
  return data
}

/** Matter list multi-select support: a committed bulk run's report. */
export async function bulkRunReport(p: Principal, bulkOperation: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const op = await tx.query(
        `select id, operation_kind, dry_run_summary, committed_at, committed_by,
                reversible_until, reversed_at, reversed_by
           from deedbox.bulk_operation where id = $1`,
        [bulkOperation],
      )
      if (op.rowCount === 0) throw new OperationRefused('not_found', 'no such bulk run')
      const items = await tx.query(
        `select i.id, i.entity_type, i.entity, i.before, i.after, i.reversal_outcome, i.block_reason,
                m.matter_number
           from deedbox.bulk_operation_item i
           left join deedbox.matter m on m.id = i.entity and i.entity_type = 'matter'
          where i.operation = $1 order by i.id`,
        [bulkOperation],
      )
      const o = op.rows[0]
      return {
        run: {
          id: o.id as number,
          kind: o.operation_kind as string,
          committedAt: o.committed_at ? String(o.committed_at) : null,
          reversibleUntil: String(o.reversible_until),
          reversedAt: o.reversed_at ? String(o.reversed_at) : null,
          stillReversible:
            o.reversed_at === null && new Date(String(o.reversible_until)).getTime() > Date.now(),
        },
        items: items.rows.map((r) => ({
          id: r.id as number,
          entityType: r.entity_type as string,
          entity: r.entity as number,
          matterNumber: (r.matter_number as string) ?? null,
          before: r.before,
          after: r.after,
          reversalOutcome: (r.reversal_outcome as string) ?? null,
          blockReason: (r.block_reason as string) ?? null,
        })),
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

/** Intake list and board (plus the stage administration data). */
export async function intakeBoard(
  p: Principal,
  f: { state?: string; practiceArea?: number; outcome?: number } = {},
) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const enabled = await settingBool(tx, 'intake.enabled')
      const stages = await tx.query(
        `select id, name, position, active from deedbox.intake_stage
          order by active desc, position`,
      )
      const records = enabled
        ? await tx.query(
            `select ir.id, ir.about, ir.contact_phone, ir.contact_email, ir.state, ir.stage,
                    ir.outcome_reason, ir.created_at, ir.converted_matter,
                    pt.display_name as prospect_name, pa.name as area_name,
                    st.name as stage_name, st.active as stage_active,
                    oc.label as outcome_label, m.matter_number as converted_number
               from deedbox.intake_record ir
               join deedbox.party pt on pt.id = ir.prospect_party
               left join deedbox.practice_area pa on pa.id = ir.practice_area
               left join deedbox.intake_stage st on st.id = ir.stage
               left join deedbox.choice_item oc on oc.id = ir.outcome_reason
               left join deedbox.matter m on m.id = ir.converted_matter
              where not ir.test_flag and ir.deleted_at is null
                and ($1::text is null or ir.state = $1)
                and ($2::bigint is null or ir.practice_area = $2)
                and ($3::bigint is null or ir.outcome_reason = $3)
              order by ir.id desc limit 500`,
            [f.state ?? null, f.practiceArea ?? null, f.outcome ?? null],
          )
        : { rows: [] as Record<string, unknown>[] }
      return {
        enabled,
        stages: stages.rows.map((r) => ({
          id: r.id as number,
          name: r.name as string,
          position: r.position as number,
          active: r.active as boolean,
        })),
        records: records.rows.map((r) => ({
          id: r.id as number,
          about: r.about as string,
          prospectName: r.prospect_name as string,
          contactPhone: r.contact_phone as string,
          contactEmail: (r.contact_email as string) ?? null,
          state: r.state as string,
          stage: (r.stage as number) ?? null,
          stageName: (r.stage_name as string) ?? null,
          stageActive: (r.stage_active as boolean) ?? null,
          areaName: (r.area_name as string) ?? null,
          outcomeLabel: (r.outcome_label as string) ?? null,
          convertedMatter: (r.converted_matter as number) ?? null,
          convertedNumber: (r.converted_number as string) ?? null,
          createdAt: String(r.created_at),
        })),
      }
    },
    { readOnly: true },
  )
}

/** Intake counts tiles: open records per stage; outcomes by reason
 * over a period. Live figures, same record set as the board. */
export async function intakeTiles(p: Principal, periodDays = 30) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const perStage = await tx.query(
        `select coalesce(st.name, '(no stage)') as stage_name, count(*)::int as n
           from deedbox.intake_record ir
           left join deedbox.intake_stage st on st.id = ir.stage
          where ir.state = 'open' and not ir.test_flag and ir.deleted_at is null
          group by st.name, st.position
          order by st.position nulls first`,
      )
      const outcomes = await tx.query(
        `select coalesce(oc.label, '(none recorded)') as outcome, count(*)::int as n
           from deedbox.intake_record ir
           left join deedbox.choice_item oc on oc.id = ir.outcome_reason
          where ir.outcome_at > now() - make_interval(days => $1)
            and not ir.test_flag and ir.deleted_at is null
          group by oc.label order by n desc`,
        [periodDays],
      )
      return {
        perStage: perStage.rows as { stage_name: string; n: number }[],
        outcomes: outcomes.rows as { outcome: string; n: number }[],
        periodDays,
      }
    },
    { readOnly: true },
  )
}

/** The intake record screen. */
export async function intakeRecord(p: Principal, intakeId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select ir.*, pt.display_name as prospect_name,
                pa.name as area_name, st.name as stage_name,
                oc.label as outcome_label, m.matter_number as converted_number
           from deedbox.intake_record ir
           join deedbox.party pt on pt.id = ir.prospect_party
           left join deedbox.practice_area pa on pa.id = ir.practice_area
           left join deedbox.intake_stage st on st.id = ir.stage
           left join deedbox.choice_item oc on oc.id = ir.outcome_reason
           left join deedbox.matter m on m.id = ir.converted_matter
          where ir.id = $1 and ir.deleted_at is null`,
        [intakeId],
      )
      if (r.rowCount === 0) throw new OperationRefused('not_found', 'intake record not found')
      const parties = await tx.query(
        `select ip.id, ip.party, pt.display_name, ci.label as capacity
           from deedbox.intake_party ip
           join deedbox.party pt on pt.id = ip.party
           join deedbox.choice_item ci on ci.id = ip.capacity
          where ip.intake = $1 and ip.deleted_at is null order by ip.id`,
        [intakeId],
      )
      const notes = await tx.query(
        `select id, body, noted_at from deedbox.note
          where owner_type = 'intake_record' and owner = $1 and deleted_at is null
          order by noted_at desc`,
        [intakeId],
      )
      const checks = await tx.query(
        `select cc.id, cc.run_at, cc.terms, cr.resolution
           from deedbox.conflict_check cc
           left join deedbox.conflict_resolution cr on cr."check" = cc.id
          where cc.attached_to_kind = 'intake_record' and cc.attached_to = $1
          order by cc.run_at desc`,
        [intakeId],
      )
      const row = r.rows[0]
      return {
        record: {
          id: row.id as number,
          prospectParty: row.prospect_party as number,
          prospectName: row.prospect_name as string,
          contactPhone: row.contact_phone as string,
          contactEmail: (row.contact_email as string) ?? null,
          about: row.about as string,
          notesText: (row.notes as string) ?? null,
          practiceArea: (row.practice_area as number) ?? null,
          areaName: (row.area_name as string) ?? null,
          stage: (row.stage as number) ?? null,
          stageName: (row.stage_name as string) ?? null,
          outcomeReason: (row.outcome_reason as number) ?? null,
          outcomeLabel: (row.outcome_label as string) ?? null,
          outcomeNote: (row.outcome_note as string) ?? null,
          state: row.state as string,
          convertedMatter: (row.converted_matter as number) ?? null,
          convertedNumber: (row.converted_number as string) ?? null,
          createdAt: String(row.created_at),
        },
        parties: parties.rows.map((x) => ({
          id: x.id as number,
          party: x.party as number,
          name: x.display_name as string,
          capacity: x.capacity as string,
        })),
        notes: notes.rows.map((x) => ({
          id: x.id as number,
          body: x.body as string,
          notedAt: String(x.noted_at),
        })),
        checks: checks.rows.map((x) => ({
          id: x.id as number,
          runAt: String(x.run_at),
          terms: x.terms,
          resolution: (x.resolution as string) ?? null,
        })),
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/** Conflict register: every past check, its attachment and resolution
 * state; each opens its immutable snapshot. Gated on conflict.run. */
export async function conflictRegister(p: Principal, opts: { limit?: number } = {}) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'conflict.run')
      const r = await tx.query(
        `select cc.id, cc.run_by_kind, cc.run_by, cc.run_at, cc.terms,
                cc.attached_to_kind, cc.attached_to,
                s.person_name as runner_name,
                cr.resolution, cr.action_note, cr.resolved_at,
                m.matter_number as attached_matter_number
           from deedbox.conflict_check cc
           left join deedbox.staff_member s on s.id = cc.run_by and cc.run_by_kind = 'staff'
           left join deedbox.conflict_resolution cr on cr."check" = cc.id
           left join deedbox.matter m on m.id = cc.attached_to and cc.attached_to_kind = 'matter'
          order by cc.id desc limit $1`,
        [Math.min(opts.limit ?? 100, 500)],
      )
      return r.rows.map((row) => ({
        id: row.id as number,
        runAt: String(row.run_at),
        runnerName:
          row.run_by_kind === 'staff' ? personNameText(row.runner_name) : (row.run_by_kind as string),
        terms: row.terms as { name?: string },
        attachedToKind: row.attached_to_kind as string,
        attachedTo: (row.attached_to as number) ?? null,
        attachedMatterNumber: (row.attached_matter_number as string) ?? null,
        resolution: (row.resolution as string) ?? null,
        resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      }))
    },
    { readOnly: true },
  )
}

/** A check's immutable snapshot, exactly as run. */
export async function conflictCheckDetail(p: Principal, checkId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'conflict.run')
      const r = await tx.query(
        `select cc.id, cc.run_by_kind, cc.run_by, cc.run_at, cc.terms, cc.result_snapshot,
                cc.attached_to_kind, cc.attached_to, s.person_name as runner_name,
                cr.resolution, cr.action_note, cr.resolved_at, cr.resolved_by,
                rs.person_name as resolver_name
           from deedbox.conflict_check cc
           left join deedbox.staff_member s on s.id = cc.run_by and cc.run_by_kind = 'staff'
           left join deedbox.conflict_resolution cr on cr."check" = cc.id
           left join deedbox.staff_member rs on rs.id = cr.resolved_by
          where cc.id = $1`,
        [checkId],
      )
      if (r.rowCount === 0) throw new OperationRefused('not_found', 'no such conflict check')
      const row = r.rows[0]
      return {
        id: row.id as number,
        runAt: String(row.run_at),
        runnerName:
          row.run_by_kind === 'staff' ? personNameText(row.runner_name) : (row.run_by_kind as string),
        terms: row.terms,
        snapshot: row.result_snapshot,
        attachedToKind: row.attached_to_kind as string,
        attachedTo: (row.attached_to as number) ?? null,
        resolution: (row.resolution as string) ?? null,
        actionNote: (row.action_note as string) ?? null,
        resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
        resolverName: personNameText(row.resolver_name),
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Practice areas
// ---------------------------------------------------------------------------

/** Practice area administration: areas, the relatable-pairs matrix with
 * the absent-pair default, the conflict flag, and binding pointers. */
export async function practiceAreasAdmin(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const areas = await tx.query(
        `select pa.id, pa.name, pa.active, pa.require_conflict_resolution,
                (select count(*)::int from deedbox.matter m where m.practice_area = pa.id) as matters,
                (select count(*)::int from deedbox.workflow_template wt
                  where wt.practice_area = pa.id and wt.active) as templates
           from deedbox.practice_area pa
          order by pa.active desc, pa.name`,
      )
      const pairs = await tx.query(
        `select area_a, area_b, allowed from deedbox.practice_area_relatable`,
      )
      const absentDefault = await settingBool(tx, 'matter.relations_absent_means_allowed')
      return {
        areas: areas.rows.map((r) => ({
          id: r.id as number,
          name: r.name as string,
          active: r.active as boolean,
          requireConflictResolution: r.require_conflict_resolution as boolean,
          matters: r.matters as number,
          templates: r.templates as number,
        })),
        pairs: pairs.rows as { area_a: number; area_b: number; allowed: boolean }[],
        absentDefault,
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Staffing panel
// ---------------------------------------------------------------------------

/** Staffing panel: current and past staffing, with the option data the
 * change form needs. */
export async function staffingPanel(p: Principal, matterId: number) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const m = await tx.query(
        `select id, matter_number, title, responsible_lawyer, status
           from deedbox.matter where id = $1`,
        [matterId],
      )
      if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
      const rows = await tx.query(
        `select ms.id, ms.staff, ms.role_on_matter, ms.from_at, ms.to_at, s.person_name, s.active
           from deedbox.matter_staffing ms
           join deedbox.staff_member s on s.id = ms.staff
          where ms.matter = $1
          order by (ms.to_at is null) desc, ms.from_at desc`,
        [matterId],
      )
      const staff = await tx.query(
        `select id, person_name from deedbox.staff_member where active order by login`,
      )
      return {
        matter: {
          id: m.rows[0].id as number,
          matterNumber: m.rows[0].matter_number as string,
          title: m.rows[0].title as string,
          status: m.rows[0].status as string,
          responsibleLawyer: m.rows[0].responsible_lawyer as number,
        },
        staffing: rows.rows.map((r) => ({
          id: r.id as number,
          staff: r.staff as number,
          name: personNameText(r.person_name),
          staffActive: r.active as boolean,
          role: r.role_on_matter as string,
          fromAt: String(r.from_at),
          toAt: r.to_at ? String(r.to_at) : null,
        })),
        staffOptions: staff.rows.map((r) => ({
          id: r.id as number,
          name: personNameText(r.person_name),
        })),
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Viewer convenience
// ---------------------------------------------------------------------------

/** Capability flags the matters screens branch on (display convenience —
 * every operation re-checks for itself). */
export async function mattersViewerFlags(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => ({
      close: await hasCapability(tx, p.id, 'matter.close'),
      reopen: await hasCapability(tx, p.id, 'matter.reopen'),
      restriction: await hasCapability(tx, p.id, 'restriction.manage'),
      merge: await hasCapability(tx, p.id, 'merge.execute'),
      conflict: await hasCapability(tx, p.id, 'conflict.run'),
      intakeConvert: await hasCapability(tx, p.id, 'intake.convert'),
      lists: await hasCapability(tx, p.id, 'lists.manage'),
      restrictedContact: (await settingText(tx, 'conflict.restricted_match_contact')) ?? 'role',
    }),
    { readOnly: true },
  )
}
