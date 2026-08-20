// Disbursements and cost types. The tax key binds to the active pack's
// declarations by schema trigger; the closed-matter guard mirrors time
// capture's.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability, defaultTaxTreatment } from '@/lib/ops/shared'

export async function createDisbursement(
  p: Principal,
  input: {
    matter: number
    incurredDate: string
    description?: string
    amount?: number
    /**
     * Total-first entry: the person types
     * the tax-INCLUSIVE total off the supplier document, and the stored
     * amount is the exclusive figure whose computed tax lands that total
     * EXACTLY — derived against the pack's own rule so the arithmetic can
     * never disagree with billing. A total the add-on rounding cannot land
     * refuses honestly rather than shifting a cent. Mutually exclusive
     * with `amount`.
     */
    inclusiveTotal?: number
    taxTreatment?: string
    costType?: number
    billable?: boolean
  },
): Promise<{ id: number }> {
  requireStaff(p)
  if (input.amount !== undefined && input.inclusiveTotal !== undefined) {
    throw new OperationRefused('bad_amount', 'give the amount or the inclusive total, not both')
  }
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(`select status from deedbox.matter where id = $1`, [input.matter])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    if (m.rows[0].status === 'closed' || m.rows[0].status === 'archived') {
      if (!(await hasCapability(tx, p.id, 'matter.edit_closed'))) {
        throw new OperationRefused('matter_closed', 'this matter is closed; recording needs matter.edit_closed')
      }
    }
    let description = input.description
    let amount = input.amount
    let tax = input.taxTreatment
    if (input.inclusiveTotal !== undefined) {
      if (!(input.inclusiveTotal > 0)) {
        throw new OperationRefused('amount_required', 'a disbursement needs its total above zero')
      }
      // no treatment named = the pack's declared default (the trigger
      // refuses undeclared keys once a pack governs, so the default must
      // come from the pack, never from an engine literal)
      const key = tax ?? (await defaultTaxTreatment(tx, p.firm))
      const totalCents = Math.round(input.inclusiveTotal * 100)
      const rate = await tx.query(`select deedbox.tax_rate($1, $2) as r`, [p.firm, key])
      const r = Number(rate.rows[0]?.r ?? 0)
      const guess = Math.round((totalCents * r) / (1 + r))
      let derived: number | null = null
      for (const g of [guess, guess - 1, guess + 1]) {
        const net = totalCents - g
        if (net <= 0) continue
        const check = await tx.query(`select deedbox.line_tax($1, $2::numeric, $3) as t`, [
          p.firm,
          net / 100,
          key,
        ])
        if (Math.round(Number(check.rows[0].t) * 100) === g) {
          derived = net
          break
        }
      }
      if (derived === null) {
        throw new OperationRefused(
          'tax_cents',
          `a tax-inclusive total of $${(totalCents / 100).toFixed(2)} cannot land exactly under the ${key} rule — check the supplier document's figures, or record it with the exclusive amount`,
        )
      }
      amount = derived / 100
      tax = key
    }
    if (input.costType !== undefined) {
      const ct = await tx.query(
        `select name, default_amount, default_tax_treatment, active
           from deedbox.cost_type where id = $1`,
        [input.costType],
      )
      if (ct.rowCount === 0) throw new OperationRefused('not_found', 'cost type not found')
      if (!ct.rows[0].active) throw new OperationRefused('cost_type_inactive', 'this cost type is inactive')
      description = description ?? (ct.rows[0].name as string)
      amount = amount ?? (ct.rows[0].default_amount === null ? undefined : Number(ct.rows[0].default_amount))
      tax = tax ?? (ct.rows[0].default_tax_treatment as string)
    }
    if (!description?.trim()) throw new OperationRefused('description_required', 'what was the cost?')
    if (amount === undefined || amount <= 0) {
      throw new OperationRefused('amount_required', 'a disbursement needs its amount above zero')
    }
    if (!tax?.trim()) throw new OperationRefused('tax_required', 'a tax treatment is required')

    const r = await tx.query(
      `insert into deedbox.disbursement
         (matter, incurred_date, description, amount, tax_treatment, billable, cost_type, created_by)
       values ($1,$2::date,$3,$4,$5,$6,$7,$8) returning id`,
      [
        input.matter,
        input.incurredDate,
        description,
        amount,
        tax,
        input.billable ?? true,
        input.costType ?? null,
        p.id,
      ],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'disbursement',
      subject: id,
      matter: input.matter,
      detail: { description, amount },
    })
    return { id }
  })
}

export async function editDisbursement(
  p: Principal,
  input: { disbursement: number; description?: string; amount?: number; incurredDate?: string; billable?: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const cur = await tx.query(
      `select * from deedbox.disbursement where id = $1 and deleted_at is null for update`,
      [input.disbursement],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'disbursement not found')
    const d = cur.rows[0]
    if (d.billed_state !== 'unbilled') {
      throw new OperationRefused('value_locked', 'a drafted or billed disbursement no longer changes')
    }
    await tx.query(
      `update deedbox.disbursement
          set description = coalesce($2, description),
              amount = coalesce($3, amount),
              incurred_date = coalesce($4::date, incurred_date),
              billable = coalesce($5, billable)
        where id = $1`,
      [
        input.disbursement,
        input.description ?? null,
        input.amount ?? null,
        input.incurredDate ?? null,
        input.billable ?? null,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'disbursement',
      subject: input.disbursement,
      matter: d.matter as number,
      detail: {
        before: { description: d.description, amount: Number(d.amount) },
        after: { description: input.description ?? d.description, amount: input.amount ?? Number(d.amount) },
      },
    })
  })
}

export async function createCostType(
  p: Principal,
  input: { name: string; defaultAmount?: number; defaultTaxTreatment?: string },
): Promise<{ id: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const treatment = input.defaultTaxTreatment ?? (await defaultTaxTreatment(tx, p.firm))
    const r = await tx.query(
      `insert into deedbox.cost_type (name, default_amount, default_tax_treatment)
       values ($1, $2, $3) returning id`,
      [input.name.trim(), input.defaultAmount ?? null, treatment],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'cost_type',
      subject: id,
      detail: { name: input.name.trim() },
    })
    return { id }
  })
}

export async function deactivateCostType(p: Principal, input: { costType: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.cost_type set active = false where id = $1 and active returning name`,
      [input.costType],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'no active cost type by that id')
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'cost_type',
      subject: input.costType,
      detail: { before: { active: true }, after: { active: false } },
    })
  })
}
