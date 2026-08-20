// Country-pack version activation. The validation and the activation flip
// live in the schema's activate_pack function (0002): every declaration
// is checked against the rule-point catalogue and its permitted kinds, a
// single bad declaration refuses the whole activation, and the privileged
// pack.activated entry (before/after versions) is written by the function
// inside this transaction. Deeper per-point body validation lands with
// each consuming stage's schemas, as 0002 records.

import type { Principal } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'

export async function activatePackVersion(
  p: Principal,
  input: { version: number },
): Promise<{ pack: number; version: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'pack.activate')
    const v = await tx.query(
      `select pv.id, pv.pack, f.country_pack as firm_pack
         from deedbox.pack_version pv
         join deedbox.firm f on f.id = $2
        where pv.id = $1`,
      [input.version, p.firm],
    )
    if (v.rowCount === 0) throw new OperationRefused('not_found', 'no such pack version')
    if (v.rows[0].pack !== v.rows[0].firm_pack) {
      throw new OperationRefused('wrong_pack', "that version does not belong to this firm's country pack")
    }
    try {
      await tx.query(`select deedbox.activate_pack($1, $2, $3, $4)`, [
        v.rows[0].pack,
        input.version,
        p.kind,
        p.id,
      ])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('pack refused at activation')) {
        throw new OperationRefused('pack_invalid', msg)
      }
      throw err
    }
    return { pack: v.rows[0].pack as number, version: input.version }
  })
}
