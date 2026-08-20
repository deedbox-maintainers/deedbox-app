// Link parties. Both active, distinct, live uniqueness
// free; one transaction: the link row plus its register entry.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'

export async function linkParties(
  p: Principal,
  input: { fromParty: number; toParty: number; linkKind: number; note?: string },
): Promise<{ id: number }> {
  requireStaff(p)
  if (input.fromParty === input.toParty) {
    throw new OperationRefused('self_link', 'a party is never linked to itself')
  }
  return withPrincipal(p, async (tx) => {
    const parties = await tx.query(
      `select id, state, deleted_at from deedbox.party where id = any($1)`,
      [[input.fromParty, input.toParty]],
    )
    if (parties.rowCount !== 2) throw new OperationRefused('not_found', 'party not found')
    for (const row of parties.rows) {
      if (row.state !== 'active' || row.deleted_at !== null) {
        throw new OperationRefused('party_inactive', 'links join active parties only')
      }
    }
    const dup = await tx.query(
      `select 1 from deedbox.party_link
        where from_party = $1 and to_party = $2 and link_kind = $3 and deleted_at is null`,
      [input.fromParty, input.toParty, input.linkKind],
    )
    if (dup.rowCount! > 0) {
      throw new OperationRefused('link_exists', 'this link already exists')
    }
    const r = await tx.query(
      `insert into deedbox.party_link (from_party, to_party, link_kind, note)
       values ($1, $2, $3, $4) returning id`,
      [input.fromParty, input.toParty, input.linkKind, input.note ?? null],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'party_link',
      subject: id,
      detail: { from_party: input.fromParty, to_party: input.toParty },
    })
    return { id }
  })
}
