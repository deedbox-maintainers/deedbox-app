// `restriction.compute_delta`, the dry-run service: given ONE proposed
// grant/block change on a matter, return exactly who gains and who loses
// sight, without writing anything. The matter domain's restriction panel
// presents this before commit.
//
// The evaluation replays the visibility predicate over committed rows for
// every active staff member, in its strict order: blocks first (absolute),
// then restriction (grant names the person or their role), then the firm
// visibility scope for unrestricted matters. Portal parties ride the same
// delta: a matter becoming restricted takes portal sight away with it,
// and a lift restores it — the panel must say so.
//
// Caller gating mirrors the write operation: restriction.manage, and
// the caller must pass the predicate on the matter — the row-security select
// IS that check.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'
import type { RestrictionChange } from '@/lib/ops/matters/restriction'

const ENUMERATION_CAP = 1000 // mirrors the register's membership cap

export interface VisibilityDelta {
  restrictedNow: boolean
  restrictedAfter: boolean
  seesNow: number
  seesAfter: number
  /** Staff gaining sight, enumerated to the cap. */
  gains: { staff: number; name: string }[]
  /** Staff losing sight, enumerated to the cap. */
  loses: { staff: number; name: string }[]
  /** Portal parties whose portal sight flips with the restricted flag. */
  portalGains: { party: number; name: string }[]
  portalLoses: { party: number; name: string }[]
}

interface StaffRow {
  id: number
  name: string
  role: number
  office: number
}

function displayName(personName: unknown): string {
  const p = personName as { given?: string; family?: string } | null
  if (!p) return ''
  return [p.given, p.family].filter(Boolean).join(' ')
}

function sees(
  s: StaffRow,
  ctx: {
    restricted: boolean
    grants: { granteeKind: string; grantee: number }[]
    blocks: Set<number>
    scope: string
    matterOffice: number
    staffedIds: Set<number>
    responsibleLawyer: number
  },
): boolean {
  // Blocks first — absolute, defeats everything.
  if (ctx.blocks.has(s.id)) return false
  // Then restriction.
  if (ctx.restricted) {
    return ctx.grants.some(
      (g) =>
        (g.granteeKind === 'staff' && g.grantee === s.id) ||
        (g.granteeKind === 'role' && g.grantee === s.role),
    )
  }
  // Then firm policy on unrestricted matters.
  if (ctx.scope === 'office') return ctx.matterOffice === s.office
  if (ctx.scope === 'assignment') return ctx.staffedIds.has(s.id) || ctx.responsibleLawyer === s.id
  return true // all_staff
}

/**
 * The panel's "resolved effective membership": who can see the matter right
 * now, by the same algebra the delta replays. Caller must already have
 * predicate-checked the matter (the queries here are plain row reads).
 */
export async function effectiveViewersInTx(
  tx: Tx,
  matter: { id: number; office: number; responsible_lawyer: number },
): Promise<{ restricted: boolean; viewers: { staff: number; name: string }[] }> {
  const staff = await tx.query(
    `select id, person_name, role, office from deedbox.staff_member where active order by id`,
  )
  const grantsR = await tx.query(
    `select grantee_kind, grantee from deedbox.matter_restriction_grant where matter = $1`,
    [matter.id],
  )
  const blocksR = await tx.query(
    `select staff from deedbox.matter_restriction_block where matter = $1`,
    [matter.id],
  )
  const staffingR = await tx.query(
    `select staff from deedbox.matter_staffing where matter = $1 and to_at is null`,
    [matter.id],
  )
  const scopeR = await tx.query(
    `select deedbox.current_setting_value('visibility.staff_scope') #>> '{}' as v`,
  )
  const grants = grantsR.rows.map((r) => ({
    granteeKind: r.grantee_kind as string,
    grantee: r.grantee as number,
  }))
  const ctx = {
    restricted: grants.length > 0,
    grants,
    blocks: new Set<number>(blocksR.rows.map((r) => r.staff as number)),
    scope: (scopeR.rows[0]?.v as string) ?? 'all_staff',
    matterOffice: matter.office,
    staffedIds: new Set<number>(staffingR.rows.map((r) => r.staff as number)),
    responsibleLawyer: matter.responsible_lawyer,
  }
  const viewers: { staff: number; name: string }[] = []
  for (const r of staff.rows) {
    const s: StaffRow = {
      id: r.id as number,
      name: displayName(r.person_name),
      role: r.role as number,
      office: r.office as number,
    }
    if (sees(s, ctx) && viewers.length < ENUMERATION_CAP) {
      viewers.push({ staff: s.id, name: s.name })
    }
  }
  return { restricted: ctx.restricted, viewers }
}

export async function computeRestrictionDelta(
  p: Principal,
  input: { matter: number; change: RestrictionChange },
): Promise<VisibilityDelta> {
  return withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'restriction.manage')
      // Predicate check: an invisible matter returns no row.
      const m = await tx.query(
        `select id, office, responsible_lawyer, restricted from deedbox.matter where id = $1`,
        [input.matter],
      )
      if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
      const matter = m.rows[0] as {
        id: number
        office: number
        responsible_lawyer: number
        restricted: boolean
      }

      const staff = await tx.query(
        `select id, person_name, role, office from deedbox.staff_member where active order by id`,
      )
      const staffRows: StaffRow[] = staff.rows.map((r) => ({
        id: r.id as number,
        name: displayName(r.person_name),
        role: r.role as number,
        office: r.office as number,
      }))

      const grantsR = await tx.query(
        `select grantee_kind, grantee from deedbox.matter_restriction_grant where matter = $1`,
        [input.matter],
      )
      const blocksR = await tx.query(
        `select staff from deedbox.matter_restriction_block where matter = $1`,
        [input.matter],
      )
      const staffingR = await tx.query(
        `select staff from deedbox.matter_staffing where matter = $1 and to_at is null`,
        [input.matter],
      )
      const scopeR = await tx.query(
        `select deedbox.current_setting_value('visibility.staff_scope') #>> '{}' as v`,
      )

      const grantsNow = grantsR.rows.map((r) => ({
        granteeKind: r.grantee_kind as string,
        grantee: r.grantee as number,
      }))
      const blocksNow = new Set<number>(blocksR.rows.map((r) => r.staff as number))
      const staffedIds = new Set<number>(staffingR.rows.map((r) => r.staff as number))
      const scope = (scopeR.rows[0]?.v as string) ?? 'all_staff'

      // Simulate the proposed change onto copies of the row sets.
      const c = input.change
      const grantsAfter = [...grantsNow]
      const blocksAfter = new Set(blocksNow)
      if (c.action === 'add_grant') {
        if (!grantsAfter.some((g) => g.granteeKind === c.granteeKind && g.grantee === c.grantee)) {
          grantsAfter.push({ granteeKind: c.granteeKind, grantee: c.grantee })
        }
      } else if (c.action === 'remove_grant') {
        const i = grantsAfter.findIndex(
          (g) => g.granteeKind === c.granteeKind && g.grantee === c.grantee,
        )
        if (i === -1) throw new OperationRefused('not_found', 'no such grant')
        grantsAfter.splice(i, 1)
      } else if (c.action === 'add_block') {
        blocksAfter.add(c.staff)
      } else {
        if (!blocksAfter.has(c.staff)) throw new OperationRefused('not_found', 'no such block')
        blocksAfter.delete(c.staff)
      }

      const restrictedNow = grantsNow.length > 0
      const restrictedAfter = grantsAfter.length > 0

      const base = {
        scope,
        matterOffice: matter.office,
        staffedIds,
        responsibleLawyer: matter.responsible_lawyer,
      }
      const gains: { staff: number; name: string }[] = []
      const loses: { staff: number; name: string }[] = []
      let seesNow = 0
      let seesAfter = 0
      for (const s of staffRows) {
        const now = sees(s, { ...base, restricted: restrictedNow, grants: grantsNow, blocks: blocksNow })
        const after = sees(s, {
          ...base,
          restricted: restrictedAfter,
          grants: grantsAfter,
          blocks: blocksAfter,
        })
        if (now) seesNow++
        if (after) seesAfter++
        if (!now && after && gains.length < ENUMERATION_CAP) gains.push({ staff: s.id, name: s.name })
        if (now && !after && loses.length < ENUMERATION_CAP) loses.push({ staff: s.id, name: s.name })
      }

      // Portal sight flips only with the restricted flag.
      const portalGains: { party: number; name: string }[] = []
      const portalLoses: { party: number; name: string }[] = []
      if (restrictedNow !== restrictedAfter) {
        const portal = await tx.query(
          `select distinct pt.id, pt.display_name
             from deedbox.matter_party mp
             join deedbox.party pt on pt.id = mp.party
            where mp.matter = $1 and mp.deleted_at is null
              and mp.portal_access and pt.portal_login is not null`,
          [input.matter],
        )
        for (const r of portal.rows) {
          const entry = { party: r.id as number, name: r.display_name as string }
          if (restrictedAfter) portalLoses.push(entry)
          else portalGains.push(entry)
        }
      }

      return {
        restrictedNow,
        restrictedAfter,
        seesNow,
        seesAfter,
        gains,
        loses,
        portalGains,
        portalLoses,
      }
    },
    { readOnly: true },
  )
}
