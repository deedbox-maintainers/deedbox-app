// Bill drafting, edits, write-downs and approval. A bill group exists for
// every billing event; siblings carry computed shares with the
// largest-remainder residual recorded per item; the item's bill_line
// pointer is the concurrency lock — a second draft of the same item loses.
//
// Implementation notes for the in-draft edits:
//   * While siblings sit pending approval, remove/write-down edits stay
//     available to the submitter and to any bill.approve holder. A
//     NEW line, however, can only be drafted onto a draft bill — the schema
//     line guard enforces it — so adding a manual line while pending is a
//     typed refusal: send the group back to draft first.
//   * A write-down applies at item level and is recomputed per sibling by
//     share, largest-remainder. Where a sibling's recomputed cut equals its
//     original line value the line is left untouched (the schema demands
//     written_down_to be STRICTLY below original); cent excesses from
//     rounding are repaired against siblings with headroom, so the item's
//     written-down total is exact.
//   * Every such edit recomputes the group's matter_total so the issue
//     identity (Σ sibling totals = matter_total) holds over the edited
//     shape, and merges the residual assignment into the group's
//     rounding_record.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability, settingBool, defaultTaxTreatment } from '@/lib/ops/shared'

interface Item {
  itemType: 'time_entry' | 'disbursement'
  id: number
  value: number
  description: string
  kind: 'time' | 'fixed_fee' | 'disbursement'
  quantityUnits: number | null
  rate: number | null
  taxTreatment: string
  categoryKey: string
}

async function loadUnbilledItems(
  tx: Tx,
  firm: number,
  matterId: number,
  timeEntries: number[],
  disbursements: number[],
): Promise<Item[]> {
  const items: Item[] = []
  // professional fees carry the pack's base (default) treatment — never an
  // engine literal, which the trigger would refuse under a governing pack
  const baseTreatment = await defaultTaxTreatment(tx, firm)
  if (timeEntries.length > 0) {
    const r = await tx.query(
      `select te.id, te.kind, te.units, te.applied_rate, te.value, te.narrative,
              te.billed_state, te.matter, ci.shipped_key, ci.label
         from deedbox.time_entry te
         join deedbox.choice_item ci on ci.id = te.category
        where te.id = any($1) and te.deleted_at is null order by te.id`,
      [timeEntries],
    )
    if (r.rowCount !== timeEntries.length) {
      throw new OperationRefused('not_found', 'a selected time entry does not exist')
    }
    for (const e of r.rows) {
      if (e.matter !== matterId) throw new OperationRefused('wrong_matter', 'items belong to one matter')
      if (e.billed_state !== 'unbilled') {
        throw new OperationRefused('not_unbilled', `time entry ${e.id} is not unbilled`)
      }
      items.push({
        itemType: 'time_entry',
        id: e.id as number,
        value: Number(e.value),
        description: e.narrative as string,
        kind: e.kind === 'fixed_fee' ? 'fixed_fee' : 'time',
        quantityUnits: e.units as number | null,
        rate: e.applied_rate === null ? null : Number(e.applied_rate),
        taxTreatment: baseTreatment,
        categoryKey: (e.shipped_key as string | null) ?? (e.label as string),
      })
    }
  }
  if (disbursements.length > 0) {
    const r = await tx.query(
      `select id, description, amount, billed_state, matter, tax_treatment
         from deedbox.disbursement
        where id = any($1) and deleted_at is null order by id`,
      [disbursements],
    )
    if (r.rowCount !== disbursements.length) {
      throw new OperationRefused('not_found', 'a selected disbursement does not exist')
    }
    for (const d of r.rows) {
      if (d.matter !== matterId) throw new OperationRefused('wrong_matter', 'items belong to one matter')
      if (d.billed_state !== 'unbilled') {
        throw new OperationRefused('not_unbilled', `disbursement ${d.id} is not unbilled`)
      }
      items.push({
        itemType: 'disbursement',
        id: d.id as number,
        value: Number(d.amount),
        description: d.description as string,
        kind: 'disbursement',
        quantityUnits: null,
        rate: null,
        taxTreatment: d.tax_treatment as string,
        categoryKey: 'disbursement',
      })
    }
  }
  return items
}

/** Largest-remainder split of one value across shares, exact to the cent. */
export function splitByShares(value: number, shares: number[]): number[] {
  const cents = Math.round(value * 100)
  const raw = shares.map((s) => (cents * s) / 100)
  const floors = raw.map((x) => Math.floor(x))
  let residual = cents - floors.reduce((a, b) => a + b, 0)
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac)
  const out = [...floors]
  for (const { i } of order) {
    if (residual <= 0) break
    out[i] += 1
    residual -= 1
  }
  return out.map((c) => c / 100)
}

export interface CreateDraftInput {
  matter: number
  timeEntries?: number[]
  disbursements?: number[]
  manualLines?: { description: string; amount: number; taxTreatment?: string }[]
  /** Set when the draft is created by a billing run. */
  billingRun?: number
}

/** Create a draft bill group for one matter. */
export async function createDraftBillGroup(
  p: Principal,
  input: CreateDraftInput,
): Promise<{ group: number; bills: number[] }> {
  requireStaff(p)
  const teIds = input.timeEntries ?? []
  const dIds = input.disbursements ?? []
  const manual = input.manualLines ?? []
  if (teIds.length + dIds.length + manual.length === 0) {
    throw new OperationRefused('nothing_selected', 'a draft needs at least one item or manual line')
  }
  for (const m of manual) {
    if (!m.description.trim() || !(m.amount > 0)) {
      throw new OperationRefused('bad_manual_line', 'manual lines carry a description and a positive amount')
    }
  }
  return withPrincipal(p, async (tx) => {
    const matter = await tx.query(`select id from deedbox.matter where id = $1 for update`, [
      input.matter,
    ])
    if (matter.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')

    const items = await loadUnbilledItems(tx, p.firm, input.matter, teIds, dIds)
    const itemsTotal = items.reduce((s, x) => s + x.value, 0)
    const manualTotal = manual.reduce((s, x) => s + x.amount, 0)
    const matterTotal = Math.round((itemsTotal + manualTotal) * 100) / 100

    const payerRows = await tx.query(
      `select payer_party, share_pct from deedbox.matter_payer
        where matter = $1 and active order by id`,
      [input.matter],
    )
    const payers =
      payerRows.rowCount! > 0
        ? payerRows.rows.map((r) => ({ party: r.payer_party as number, share: Number(r.share_pct) }))
        : [
            {
              party: (
                await tx.query(`select client_party from deedbox.matter where id = $1`, [
                  input.matter,
                ])
              ).rows[0].client_party as number,
              share: 100,
            },
          ]

    const group = await tx.query(
      `insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot, billing_run)
       values ($1, $2, $3, $4) returning id`,
      [input.matter, matterTotal, JSON.stringify(payers), input.billingRun ?? null],
    )
    const groupId = group.rows[0].id as number

    const billIds: number[] = []
    for (const payer of payers) {
      const b = await tx.query(
        `insert into deedbox.bill (bill_group, matter, payer_party, share_pct)
         values ($1, $2, $3, $4) returning id`,
        [groupId, input.matter, payer.party, payer.share],
      )
      billIds.push(b.rows[0].id as number)
    }

    // lines: one per item per sibling at shares, largest-remainder to the cent
    const shares = payers.map((x) => x.share)
    let position = 0
    for (const item of items) {
      position += 1
      const split = splitByShares(item.value, shares)
      let pointerLine: number | null = null
      let bestShareIdx = shares.indexOf(Math.max(...shares))
      for (let i = 0; i < billIds.length; i++) {
        // tax per line from the pack's billing.tax rule, at creation (0049)
        const line = await tx.query(
          `insert into deedbox.bill_line
             (bill, position, kind, source_entry, description, quantity_units, rate,
              original_value, amount, tax_treatment, tax_amount, category_key)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,deedbox.line_tax($11,$8,$9),$10) returning id`,
          [
            billIds[i],
            position,
            item.kind,
            item.id,
            item.description,
            item.quantityUnits,
            item.rate,
            split[i],
            item.taxTreatment,
            item.categoryKey,
            p.firm,
          ],
        )
        if (i === bestShareIdx) pointerLine = line.rows[0].id as number
      }
      await tx.query(
        `update deedbox.${item.itemType} set billed_state = 'on_draft', bill_line = $2
          where id = $1 and billed_state = 'unbilled'`,
        [item.id, pointerLine],
      )
    }
    const manualBase = manual.length > 0 ? await defaultTaxTreatment(tx, p.firm) : null
    for (const m of manual) {
      position += 1
      const split = splitByShares(m.amount, shares)
      for (let i = 0; i < billIds.length; i++) {
        await tx.query(
          `insert into deedbox.bill_line
             (bill, position, kind, description, original_value, amount,
              tax_treatment, tax_amount, category_key)
           values ($1,$2,'manual',$3,$4,$4,$5,deedbox.line_tax($6,$4,$5),'manual')`,
          [billIds[i], position, m.description, split[i], m.taxTreatment ?? manualBase, p.firm],
        )
      }
    }

    // the group's total is the issue identity's figure — Σ (amount + tax)
    // over the sibling lines — so with tax now real it is recomputed from
    // the lines just written (0049); the item values seeded it above
    const groupTotal = await recomputeMatterTotal(tx, groupId)

    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'bill_group',
      subject: groupId,
      matter: input.matter,
      detail: { matter_total: groupTotal, bills: billIds.length },
    })
    for (const b of billIds) {
      await emitRegister(tx, p, {
        kind: 'record.created',
        subjectType: 'bill',
        subject: b,
        matter: input.matter,
      })
    }
    return { group: groupId, bills: billIds }
  })
}

/**
 * The abandon body, callable inside a caller-owned transaction (a billing
 * run's abandon sweeps every group in one transaction).
 */
export async function abandonGroupInTx(tx: Tx, p: Principal, groupId: number): Promise<void> {
  const g = await tx.query(
    `select matter, state from deedbox.bill_group where id = $1 for update`,
    [groupId],
  )
  if (g.rowCount === 0) throw new OperationRefused('not_found', 'bill group not found')
  if (g.rows[0].state !== 'draft') {
    throw new OperationRefused('not_draft', 'only draft groups abandon')
  }
  const bills = await tx.query(
    `select id, state from deedbox.bill where bill_group = $1 order by id`,
    [groupId],
  )
  for (const b of bills.rows) {
    if (b.state !== 'draft' && b.state !== 'pending_approval') {
      throw new OperationRefused('not_draft', 'an issued sibling can never be abandoned')
    }
  }
  // release items whose pointer sits on any sibling's lines
  for (const table of ['time_entry', 'disbursement'] as const) {
    await tx.query(
      `update deedbox.${table} i
          set billed_state = 'unbilled', bill_line = null
        where i.bill_line in (
          select l.id from deedbox.bill_line l
           join deedbox.bill b on b.id = l.bill where b.bill_group = $1)`,
      [groupId],
    )
  }
  await tx.query(
    `delete from deedbox.bill_line
      where bill in (select id from deedbox.bill where bill_group = $1)`,
    [groupId],
  )
  await tx.query(`delete from deedbox.bill where bill_group = $1`, [groupId])
  await tx.query(`update deedbox.bill_group set state = 'abandoned' where id = $1`, [groupId])
  await emitRegister(tx, p, {
    kind: 'record.changed',
    subjectType: 'bill_group',
    subject: groupId,
    matter: g.rows[0].matter as number,
    detail: { before: { state: 'draft' }, after: { state: 'abandoned' } },
  })
}

/** Abandon the draft group: hard-delete drafts, release items. */
export async function abandonDraftGroup(p: Principal, input: { group: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, (tx) => abandonGroupInTx(tx, p, input.group))
}

/**
 * The shared edit gate: the group must still be editable, and while any
 * sibling sits pending approval only the submitter or a bill.approve holder
 * edits.
 * Returns the group row and its sibling bills, all locked.
 */
async function editableGroup(
  tx: Tx,
  p: Principal,
  groupId: number,
): Promise<{
  matter: number
  bills: { id: number; state: string; share_pct: number; submitted_by: number | null }[]
  anyPending: boolean
}> {
  const g = await tx.query(
    `select matter, state from deedbox.bill_group where id = $1 for update`,
    [groupId],
  )
  if (g.rowCount === 0) throw new OperationRefused('not_found', 'bill group not found')
  if (g.rows[0].state !== 'draft') {
    throw new OperationRefused('not_editable', `a ${g.rows[0].state} group no longer edits`)
  }
  const bills = await tx.query(
    `select id, state, share_pct, submitted_by from deedbox.bill
      where bill_group = $1 order by id for update`,
    [groupId],
  )
  if (bills.rowCount === 0) throw new OperationRefused('empty_group', 'the group has no bills')
  const anyPending = bills.rows.some((b) => b.state === 'pending_approval')
  for (const b of bills.rows) {
    if (b.state !== 'draft' && b.state !== 'pending_approval') {
      throw new OperationRefused('not_editable', `sibling ${b.id} is ${b.state}`)
    }
  }
  if (anyPending) {
    const isSubmitter = bills.rows.some((b) => b.submitted_by === p.id)
    if (!isSubmitter && !(await hasCapability(tx, p.id, 'bill.approve'))) {
      throw new OperationRefused(
        'not_reviewer',
        'while awaiting approval, edits belong to the submitter and approvers',
      )
    }
  }
  return {
    matter: g.rows[0].matter as number,
    bills: bills.rows.map((b) => ({
      id: b.id as number,
      state: b.state as string,
      share_pct: Number(b.share_pct),
      submitted_by: b.submitted_by as number | null,
    })),
    anyPending,
  }
}

/** Recompute the group's matter_total from its current lines (issue identity). */
async function recomputeMatterTotal(tx: Tx, groupId: number): Promise<number> {
  const r = await tx.query(
    `update deedbox.bill_group g
        set matter_total = coalesce((
          select sum(l.amount + l.tax_amount) from deedbox.bill_line l
            join deedbox.bill b on b.id = l.bill
           where b.bill_group = g.id), 0)
      where g.id = $1
      returning matter_total`,
    [groupId],
  )
  return Number(r.rows[0].matter_total)
}

/**
 * Remove a line (hold an item back). Position-addressed: sibling
 * lines of one item share a position by construction; the source item, when
 * there is one, returns to unbilled.
 */
export async function removeDraftLine(
  p: Principal,
  input: { group: number; position: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const g = await editableGroup(tx, p, input.group)
    const lines = await tx.query(
      `select l.id, l.source_entry, l.kind, l.amount from deedbox.bill_line l
        join deedbox.bill b on b.id = l.bill
       where b.bill_group = $1 and l.position = $2::int`,
      [input.group, input.position],
    )
    if (lines.rowCount === 0) {
      throw new OperationRefused('not_found', `no line at position ${input.position}`)
    }
    const removedValue = lines.rows.reduce((s, l) => s + Number(l.amount), 0)
    const kind = lines.rows[0].kind as string
    // release the source item first — its pointer references a line row
    for (const table of ['time_entry', 'disbursement'] as const) {
      await tx.query(
        `update deedbox.${table} i
            set billed_state = 'unbilled', bill_line = null
          where i.bill_line = any($1)`,
        [lines.rows.map((l) => l.id)],
      )
    }
    await tx.query(`delete from deedbox.bill_line where id = any($1)`, [
      lines.rows.map((l) => l.id),
    ])
    const total = await recomputeMatterTotal(tx, input.group)
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'bill_group',
      subject: input.group,
      matter: g.matter,
      detail: {
        edit: 'line_removed',
        position: input.position,
        kind,
        released_value: Math.round(removedValue * 100) / 100,
        matter_total: total,
      },
    })
  })
}

/**
 * Write an item down. Applied at item level; each sibling line's
 * written_down_to is the share split of the written-down total,
 * largest-remainder, with cent excesses repaired against headroom and the
 * residual assignment recorded on the group's rounding_record.
 */
export async function writeDownDraftItem(
  p: Principal,
  input: { group: number; position: number; writtenDownTo: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) {
    throw new OperationRefused('reason_required', 'a write-down always carries its reason')
  }
  if (!(input.writtenDownTo >= 0)) {
    throw new OperationRefused('bad_amount', 'a write-down target is zero or above')
  }
  await withPrincipal(p, async (tx) => {
    const g = await editableGroup(tx, p, input.group)
    const lines = await tx.query(
      `select l.id, l.bill, l.original_value, l.amount from deedbox.bill_line l
        join deedbox.bill b on b.id = l.bill
       where b.bill_group = $1 and l.position = $2::int
       order by b.id`,
      [input.group, input.position],
    )
    if (lines.rowCount === 0) {
      throw new OperationRefused('not_found', `no line at position ${input.position}`)
    }
    const originalTotal =
      Math.round(lines.rows.reduce((s, l) => s + Number(l.original_value), 0) * 100) / 100
    if (!(input.writtenDownTo < originalTotal)) {
      throw new OperationRefused(
        'not_a_write_down',
        `the target ${input.writtenDownTo.toFixed(2)} must sit below the item's value ${originalTotal.toFixed(2)}`,
      )
    }

    // split the written-down total by the SIBLING LINES' original proportions
    const shares = lines.rows.map((l) => (Number(l.original_value) / originalTotal) * 100)
    const cuts = splitByShares(input.writtenDownTo, shares)

    // repair rounding excesses: no sibling cut may exceed its original value
    const originals = lines.rows.map((l) => Number(l.original_value))
    for (let i = 0; i < cuts.length; i++) {
      while (cuts[i] > originals[i]) {
        const j = cuts.findIndex((c, k) => c < originals[k] - 0.005)
        if (j < 0) throw new OperationRefused('unsplittable', 'no sibling has headroom for the residual cent')
        cuts[i] = Math.round((cuts[i] - 0.01) * 100) / 100
        cuts[j] = Math.round((cuts[j] + 0.01) * 100) / 100
      }
    }

    // the residual absorber is the sibling holding the largest cut
    let absorbedBy: number | null = null
    let maxCut = -1
    for (let i = 0; i < lines.rows.length; i++) {
      if (cuts[i] > maxCut) {
        maxCut = cuts[i]
        absorbedBy = lines.rows[i].bill as number
      }
    }
    for (let i = 0; i < lines.rows.length; i++) {
      const line = lines.rows[i]
      // the tax follows the amount (0049): re-evaluated on every change
      if (cuts[i] === Number(line.original_value)) {
        // strictly-below rule: an equal cut leaves the line untouched
        await tx.query(
          `update deedbox.bill_line
              set written_down_to = null, write_down_reason = null, amount = original_value,
                  tax_amount = deedbox.line_tax($2, original_value, tax_treatment)
            where id = $1`,
          [line.id, p.firm],
        )
      } else {
        await tx.query(
          `update deedbox.bill_line
              set written_down_to = $2, write_down_reason = $3, amount = $2,
                  tax_amount = deedbox.line_tax($4, $2, tax_treatment)
            where id = $1`,
          [line.id, cuts[i], input.reason, p.firm],
        )
      }
    }

    await tx.query(
      `update deedbox.bill_group
          set rounding_record = coalesce(rounding_record, '{}'::jsonb) || $2::jsonb
        where id = $1`,
      [
        input.group,
        JSON.stringify({
          [String(input.position)]: { written_down_to: input.writtenDownTo, absorbed_by_bill: absorbedBy },
        }),
      ],
    )
    const total = await recomputeMatterTotal(tx, input.group)
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'bill_group',
      subject: input.group,
      matter: g.matter,
      reason: input.reason,
      detail: {
        edit: 'write_down',
        position: input.position,
        before: { value: originalTotal },
        after: { value: input.writtenDownTo },
        matter_total: total,
      },
    })
  })
}

/**
 * Add a manual line across the sibling set. The schema drafts lines
 * onto DRAFT bills only, so a pending group refuses with the path out named.
 */
export async function addManualDraftLine(
  p: Principal,
  input: { group: number; description: string; amount: number; taxTreatment?: string },
): Promise<void> {
  requireStaff(p)
  if (!input.description.trim() || !(input.amount > 0)) {
    throw new OperationRefused('bad_manual_line', 'manual lines carry a description and a positive amount')
  }
  await withPrincipal(p, async (tx) => {
    const g = await editableGroup(tx, p, input.group)
    if (g.anyPending) {
      throw new OperationRefused(
        'pending_approval',
        'new lines are drafted onto draft bills only — send the group back to draft first',
      )
    }
    const pos = await tx.query(
      `select coalesce(max(l.position), 0) + 1 as p from deedbox.bill_line l
        join deedbox.bill b on b.id = l.bill where b.bill_group = $1`,
      [input.group],
    )
    const position = pos.rows[0].p as number
    const shares = g.bills.map((b) => b.share_pct)
    const split = splitByShares(input.amount, shares)
    const lineTreatment = input.taxTreatment ?? (await defaultTaxTreatment(tx, p.firm))
    for (let i = 0; i < g.bills.length; i++) {
      await tx.query(
        `insert into deedbox.bill_line
           (bill, position, kind, description, original_value, amount,
            tax_treatment, tax_amount, category_key)
         values ($1,$2,'manual',$3,$4,$4,$5,deedbox.line_tax($6,$4,$5),'manual')`,
        [g.bills[i].id, position, input.description, split[i], lineTreatment, p.firm],
      )
    }
    const total = await recomputeMatterTotal(tx, input.group)
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'bill_group',
      subject: input.group,
      matter: g.matter,
      detail: {
        edit: 'manual_line_added',
        position,
        amount: input.amount,
        matter_total: total,
      },
    })
  })
}

/**
 * Re-evaluate the pack's billing.tax rule on every line of a group (0049):
 * the rule in force now, to the cent; a no-op where nothing differs. Called
 * with the group held unissued — lines are still mutable — at submission
 * (so the approver sees the tax that will issue) and at issue.
 * Returns the number of lines whose tax moved.
 */
export async function refreshGroupTaxInTx(tx: Tx, firm: number, group: number): Promise<number> {
  const r = await tx.query(
    `update deedbox.bill_line l
        set tax_amount = deedbox.line_tax($2, l.amount, l.tax_treatment)
       from deedbox.bill b
      where b.id = l.bill and b.bill_group = $1
        and l.tax_amount is distinct from deedbox.line_tax($2, l.amount, l.tax_treatment)`,
    [group, firm],
  )
  const moved = r.rowCount ?? 0
  // the group's total (Σ amount + tax) follows, so the issue identity holds
  if (moved > 0) await recomputeMatterTotal(tx, group)
  return moved
}

/** Submit all siblings for approval together. */
export async function submitForApproval(p: Principal, input: { group: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    if (!(await settingBool(tx, 'bill.approval_required'))) {
      throw new OperationRefused('approval_off', 'the approval step is not enabled for this firm')
    }
    const g = await tx.query(
      `select matter from deedbox.bill_group where id = $1 for update`,
      [input.group],
    )
    if (g.rowCount === 0) throw new OperationRefused('not_found', 'bill group not found')
    // the approver approves the tax that will issue: re-evaluated here (0049)
    await refreshGroupTaxInTx(tx, p.firm, input.group)
    const bills = await tx.query(
      `update deedbox.bill set state = 'pending_approval', submitted_by = $2, submitted_at = now()
        where bill_group = $1 and state = 'draft' returning id`,
      [input.group, p.id],
    )
    if (bills.rowCount === 0) throw new OperationRefused('not_draft', 'no draft siblings to submit')
    for (const b of bills.rows) {
      await emitRegister(tx, p, {
        kind: 'bill.state_changed',
        subjectType: 'bill',
        subject: b.id as number,
        matter: g.rows[0].matter as number,
        detail: { before: 'draft', after: 'pending_approval' },
      })
    }
  })
}

/** Send back to draft. */
export async function sendBackToDraft(
  p: Principal,
  input: { group: number; note?: string },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    const { requireCapability } = await import('@/lib/ops/shared')
    await requireCapability(tx, p, 'bill.approve')
    const g = await tx.query(
      `select matter from deedbox.bill_group where id = $1 for update`,
      [input.group],
    )
    if (g.rowCount === 0) throw new OperationRefused('not_found', 'bill group not found')
    const bills = await tx.query(
      `update deedbox.bill set state = 'draft'
        where bill_group = $1 and state = 'pending_approval' returning id`,
      [input.group],
    )
    if (bills.rowCount === 0) throw new OperationRefused('not_pending', 'nothing awaiting approval')
    for (const b of bills.rows) {
      await emitRegister(tx, p, {
        kind: 'bill.state_changed',
        subjectType: 'bill',
        subject: b.id as number,
        matter: g.rows[0].matter as number,
        reason: input.note,
        detail: { before: 'pending_approval', after: 'draft' },
      })
    }
  })
}
