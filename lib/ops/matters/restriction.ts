// Restriction changes. Hard rows (physical insert and delete wrapped in a
// privileged register event carrying the before/after membership); the
// restricted mirror and the last-guardian invariant are the schema's (0004).
// The matter row lock is taken first so the flag recomputation and the
// guardian evaluation see a consistent row set. The acting user must pass
// the visibility predicate on the matter — the row-security select under
// their context IS that check.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'

export type RestrictionChange =
  | { action: 'add_grant'; granteeKind: 'staff' | 'role'; grantee: number }
  | { action: 'remove_grant'; granteeKind: 'staff' | 'role'; grantee: number }
  | { action: 'add_block'; staff: number }
  | { action: 'remove_block'; staff: number }

export interface Membership {
  grants: { granteeKind: string; grantee: number; name: string }[]
  blocks: { staff: number; name: string }[]
  grantCount: number
  blockCount: number
}

const MEMBERSHIP_CAP = 1000

/** The membership resolution the register entry carries — exported for the
 * restriction panel's read (same rows, same cap, one source of truth). */
export async function readMembership(tx: Tx, matterId: number): Promise<Membership> {
  const grants = await tx.query(
    `select g.grantee_kind, g.grantee,
            case g.grantee_kind
              when 'staff' then (select s.person_name #>> '{family}' from deedbox.staff_member s where s.id = g.grantee)
              else (select r.name from deedbox.role r where r.id = g.grantee)
            end as name
       from deedbox.matter_restriction_grant g
      where g.matter = $1 order by g.id limit $2`,
    [matterId, MEMBERSHIP_CAP],
  )
  const blocks = await tx.query(
    `select b.staff, (select s.person_name #>> '{family}' from deedbox.staff_member s where s.id = b.staff) as name
       from deedbox.matter_restriction_block b
      where b.matter = $1 order by b.id limit $2`,
    [matterId, MEMBERSHIP_CAP],
  )
  const counts = await tx.query(
    `select (select count(*) from deedbox.matter_restriction_grant where matter = $1)::int as g,
            (select count(*) from deedbox.matter_restriction_block where matter = $1)::int as b`,
    [matterId],
  )
  return {
    grants: grants.rows.map((r) => ({
      granteeKind: r.grantee_kind as string,
      grantee: r.grantee as number,
      name: (r.name as string) ?? String(r.grantee),
    })),
    blocks: blocks.rows.map((r) => ({
      staff: r.staff as number,
      name: (r.name as string) ?? String(r.staff),
    })),
    grantCount: counts.rows[0].g as number,
    blockCount: counts.rows[0].b as number,
  }
}

export async function changeRestriction(
  p: Principal,
  input: { matter: number; change: RestrictionChange; reason: string },
): Promise<void> {
  if (!input.reason || !input.reason.trim()) {
    throw new OperationRefused('reason_required', 'restriction changes always carry a reason')
  }
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'restriction.manage')
    // Predicate + lock in one act: an invisible matter returns no row.
    const m = await tx.query(`select id from deedbox.matter where id = $1 for update`, [
      input.matter,
    ])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')

    const before = await readMembership(tx, input.matter)
    const c = input.change
    if (c.action === 'add_grant') {
      await tx.query(
        `insert into deedbox.matter_restriction_grant (matter, grantee_kind, grantee)
         values ($1, $2, $3)`,
        [input.matter, c.granteeKind, c.grantee],
      )
    } else if (c.action === 'remove_grant') {
      const r = await tx.query(
        `delete from deedbox.matter_restriction_grant
          where matter = $1 and grantee_kind = $2 and grantee = $3`,
        [input.matter, c.granteeKind, c.grantee],
      )
      if (r.rowCount === 0) throw new OperationRefused('not_found', 'no such grant')
    } else if (c.action === 'add_block') {
      await tx.query(
        `insert into deedbox.matter_restriction_block (matter, staff) values ($1, $2)`,
        [input.matter, c.staff],
      )
    } else {
      const r = await tx.query(
        `delete from deedbox.matter_restriction_block where matter = $1 and staff = $2`,
        [input.matter, c.staff],
      )
      if (r.rowCount === 0) throw new OperationRefused('not_found', 'no such block')
    }
    const after = await readMembership(tx, input.matter)

    await emitRegister(tx, p, {
      kind: 'restriction.changed',
      subjectType: 'matter',
      subject: input.matter,
      matter: input.matter,
      privileged: true,
      reason: input.reason,
      detail: { before, after, change: c },
    })
  })
}
