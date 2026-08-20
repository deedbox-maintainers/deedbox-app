// Payer shares. The whole active set is replaced in one transaction; the
// deferred schema constraint proves the sum at commit, and the typed
// precheck names the computed sum on refusal. Applies to bill groups
// created afterwards only.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'

export async function replacePayerSet(
  p: Principal,
  input: { matter: number; payers: { party: number; sharePct: number }[] },
): Promise<void> {
  requireStaff(p)
  if (input.payers.length > 0) {
    const sum = input.payers.reduce((s, x) => s + x.sharePct, 0)
    if (Math.abs(sum - 100) > 0.005) {
      throw new OperationRefused(
        'shares_must_sum_100',
        `payer shares must sum to exactly 100.00 — the set supplied sums to ${sum.toFixed(2)}`,
      )
    }
  }
  await withPrincipal(p, async (tx) => {
    const m = await tx.query(`select id from deedbox.matter where id = $1 for update`, [
      input.matter,
    ])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    const before = await tx.query(
      `select payer_party, share_pct from deedbox.matter_payer
        where matter = $1 and active order by id`,
      [input.matter],
    )
    await tx.query(`update deedbox.matter_payer set active = false where matter = $1 and active`, [
      input.matter,
    ])
    for (const payer of input.payers) {
      const party = await tx.query(
        `select state, deleted_at from deedbox.party where id = $1`,
        [payer.party],
      )
      if (party.rowCount === 0) throw new OperationRefused('not_found', 'payer party not found')
      if (party.rows[0].state !== 'active' || party.rows[0].deleted_at !== null) {
        throw new OperationRefused('party_inactive', 'payers are active parties')
      }
      await tx.query(
        `insert into deedbox.matter_payer (matter, payer_party, share_pct) values ($1, $2, $3)`,
        [input.matter, payer.party, payer.sharePct],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter',
      subject: input.matter,
      matter: input.matter,
      detail: {
        payer_set: {
          before: before.rows,
          after: input.payers.map((x) => ({ payer_party: x.party, share_pct: x.sharePct })),
        },
      },
    })
  })
}
