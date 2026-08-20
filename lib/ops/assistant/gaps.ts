// Knowledge-gap review: low-confidence questions queue as open
// gaps; whoever curates the firm's help articles works the queue. Product
// telemetry, not evidence — no register entries.

import type { Principal } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'

export async function reviewAssistantGap(
  p: Principal,
  input: { id: number; status: 'reviewed' | 'resolved' },
): Promise<void> {
  if (!['reviewed', 'resolved'].includes(input.status)) {
    throw new OperationRefused('bad_status', 'a gap is marked reviewed or resolved')
  }
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'assistant.manage')
    const r = await tx.query(
      `update deedbox.assistant_gap set status = $3
        where id = $1 and firm = $2 returning id`,
      [input.id, p.firm, input.status],
    )
    if (r.rowCount === 0) {
      throw new OperationRefused('gap_not_found', 'no such knowledge gap')
    }
  })
}
