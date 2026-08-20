// The anomaly-alert acknowledge verb. Evaluation itself (the
// cursor-driven job) lives in its own module — the cursor table is
// read-only to the app role until its numbered write-grant change — but
// alerts raised directly (private-layer containment, resilience failures)
// and any future evaluator's rows are acknowledged here.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'

export async function acknowledgeAnomaly(p: Principal, input: { alert: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'security.administer')
    const r = await tx.query(
      `update deedbox.anomaly_alert
          set acknowledged_by = $2, acknowledged_at = now()
        where id = $1 and acknowledged_at is null
        returning id`,
      [input.alert, p.id],
    )
    if (r.rowCount === 0) {
      const exists = await tx.query(`select 1 from deedbox.anomaly_alert where id = $1`, [input.alert])
      if (exists.rowCount === 0) throw new OperationRefused('not_found', 'no such alert')
      return // already acknowledged — idempotent
    }
    await emitRegister(tx, p, {
      kind: 'anomaly.acknowledged',
      subjectType: 'anomaly_alert',
      subject: input.alert,
    })
  })
}
