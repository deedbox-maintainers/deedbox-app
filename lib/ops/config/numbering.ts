// Number-format replacement. The whole write set is the 0024
// security-definer function (supersede the active row, carry every
// series forward so nothing renumbers and nothing restarts, register the
// change); this operation is the capability gate and the typed surface.

import type { Principal } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'

export interface ReplaceNumberFormatInput {
  purpose: string
  scope?: string | null
  pattern: string
  allocationMode: 'sequence' | 'gapless'
  reset: 'never' | 'yearly' | 'daily'
}

export async function replaceNumberFormat(
  p: Principal,
  input: ReplaceNumberFormatInput,
): Promise<{ format: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'numbering.manage')
    try {
      const r = await tx.query(
        `select deedbox.replace_number_format(
           $1::deedbox.number_purpose, $2, $3, $4, $5, $6, $7, $8) as id`,
        [
          input.purpose,
          input.scope ?? null,
          input.pattern,
          input.allocationMode,
          input.reset,
          p.kind,
          p.id,
          p.session ?? null,
        ],
      )
      return { format: r.rows[0].id as number }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('number format refused')) {
        throw new OperationRefused('invalid_format', msg)
      }
      if (msg.includes('invalid input value for enum')) {
        throw new OperationRefused('invalid_format', `unknown numbering purpose ${input.purpose}`)
      }
      throw err
    }
  })
}
