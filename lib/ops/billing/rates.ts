// Pricing administration. Append-only effective-dated lists; cost-rate
// rows are privileged on the register and sit behind row security keyed
// on see_cost_rates.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability, requireStaff } from '@/lib/ops/shared'

export async function addStaffRate(
  p: Principal,
  input: { staff: number; label?: string; rate: number; effectiveFrom: string },
): Promise<{ id: number }> {
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'security.administer')
    const r = await tx.query(
      `insert into deedbox.staff_rate (staff, label, rate, effective_from)
       values ($1, coalesce($2, 'standard'), $3, $4::date) returning id`,
      [input.staff, input.label ?? null, input.rate, input.effectiveFrom],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'staff_rate',
      subject: id,
      detail: { staff: input.staff, label: input.label ?? 'standard', rate: input.rate },
    })
    return { id }
  })
}

export async function addStaffCostRate(
  p: Principal,
  input: { staff: number; rate: number; effectiveFrom: string },
): Promise<{ id: number }> {
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'security.administer')
    await requireCapability(tx, p, 'see_cost_rates')
    const r = await tx.query(
      `insert into deedbox.staff_cost_rate (staff, cost_rate, effective_from)
       values ($1, $2, $3::date) returning id`,
      [input.staff, input.rate, input.effectiveFrom],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'staff_cost_rate',
      subject: id,
      privileged: true,
      detail: { before: null, after: { staff: input.staff, rate: input.rate } },
    })
    return { id }
  })
}

export async function addMatterRateOverride(
  p: Principal,
  input: { matter: number; staff?: number; label?: string; rate: number; effectiveFrom: string },
): Promise<{ id: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(`select id from deedbox.matter where id = $1`, [input.matter])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    const r = await tx.query(
      `insert into deedbox.matter_rate_override (matter, staff, label, rate, effective_from)
       values ($1, $2, $3, $4, $5::date) returning id`,
      [input.matter, input.staff ?? null, input.label ?? null, input.rate, input.effectiveFrom],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'matter_rate_override',
      subject: id,
      matter: input.matter,
      detail: { staff: input.staff ?? null, label: input.label ?? null, rate: input.rate },
    })
    return { id }
  })
}
