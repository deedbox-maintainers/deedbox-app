// Issue a bill group. One database transaction per group; the gapless
// counter locks INSIDE it, so a refused issue consumes no number; exactly
// one issue_total journal entry per sibling; the default attribution set is
// written largest-remainder to the cent; a reminder state is born where a
// default sequence exists. Canonical lock order holds: group/bills → counter
// → journal (new bills, uncontended) → register chain.
//
// Implementation notes: the rendering is a stored JSON artefact carrying
// lines and the governing payment details (document templates land with the
// screens/templates work; the one-render-definition rule then binds THIS
// artefact as the single source); pack tax and the interest cap check engage
// when a pack declares them; open attach-to-next-bill top-up consumption
// lands with the top-up operations (T).

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability, settingBool, settingText } from '@/lib/ops/shared'
import { refreshGroupTaxInTx } from './drafting'
import { createHash } from 'node:crypto'

export interface IssueInput {
  group: number
  /** ISO date; defaults to today in the firm's timezone; never in the future. */
  issueDate?: string
  /** Per-group terms override; else billing.default_terms_days in force. */
  termsDays?: number
  /** State the applicable interest policy on these bills. */
  stateInterest?: boolean
}

export async function issueBillGroup(
  p: Principal,
  input: IssueInput,
): Promise<{ bills: { id: number; billNumber: string; total: number }[] }> {
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'bill.issue')

    const g = await tx.query(
      `select id, matter, matter_total, state from deedbox.bill_group where id = $1 for update`,
      [input.group],
    )
    if (g.rowCount === 0) throw new OperationRefused('not_found', 'bill group not found')
    if (g.rows[0].state !== 'draft') {
      throw new OperationRefused('wrong_state', `a ${g.rows[0].state} group cannot issue`)
    }
    const matterId = g.rows[0].matter as number

    const bills = await tx.query(
      `select id, state, share_pct, payer_party from deedbox.bill
        where bill_group = $1 order by id for update`,
      [input.group],
    )
    if (bills.rowCount === 0) throw new OperationRefused('empty_group', 'the group has no bills')
    const fromPending = bills.rows.some((b) => b.state === 'pending_approval')
    if (fromPending) await requireCapability(tx, p, 'bill.approve')
    for (const b of bills.rows) {
      if (b.state !== 'draft' && b.state !== 'pending_approval') {
        throw new OperationRefused('wrong_state', `sibling ${b.id} is ${b.state}`)
      }
    }
    // draft → issued exists only while approval is off; with the
    // setting on, a draft sibling must travel through pending_approval
    if (bills.rows.some((b) => b.state === 'draft') && (await settingBool(tx, 'bill.approval_required'))) {
      throw new OperationRefused(
        'approval_required',
        'this firm requires approval before issue — submit the group for approval first',
      )
    }

    // tax (0049): the rule in force at issue governs. A group that came
    // through approval was approved with the tax evaluated at submission —
    // if the rule has moved since, nobody approved the total that would
    // issue: refuse, and it goes back to draft. A draft simply issues with
    // the rule re-evaluated (which also heals lines drafted before a firm's
    // pack declared its rates).
    const staleTax = await tx.query(
      `select count(*)::int as n from deedbox.bill_line l
         join deedbox.bill b on b.id = l.bill
        where b.bill_group = $1
          and l.tax_amount is distinct from deedbox.line_tax($2, l.amount, l.tax_treatment)`,
      [input.group, p.firm],
    )
    if ((staleTax.rows[0].n as number) > 0) {
      if (fromPending) {
        throw new OperationRefused(
          'tax_changed',
          'the tax rule changed after this group was approved — send it back to draft and resubmit',
        )
      }
      await refreshGroupTaxInTx(tx, p.firm, input.group)
      // the group's total moved with the tax — re-read it for the identity check below
      const fresh = await tx.query(`select matter_total from deedbox.bill_group where id = $1`, [input.group])
      g.rows[0].matter_total = fresh.rows[0].matter_total
    }

    // dates: issue date today (firm timezone) or an explicit non-future date;
    // terms from the override else the setting in force — no fallback beyond
    const todayR = await tx.query(
      `select (now() at time zone (select timezone from deedbox.firm order by id limit 1))::date::text as d`,
    )
    const today = todayR.rows[0].d as string
    const issueDate = input.issueDate ?? today
    if (issueDate > today) {
      throw new OperationRefused('future_issue_date', 'an issue date never sits in the future')
    }
    const termsRaw = input.termsDays ?? Number((await settingText(tx, 'billing.default_terms_days')) ?? NaN)
    if (!Number.isFinite(termsRaw)) {
      throw new OperationRefused('no_terms', 'no payment terms resolve — issuance is refused')
    }

    // interest statement, when asked for and a policy applies
    let interestStatement: { annual_rate_pct: number; grace_days: number } | null = null
    if (input.stateInterest) {
      const pol = await tx.query(
        `select annual_rate_pct, grace_days from deedbox.interest_policy
          where active and ((scope = 'matter' and matter = $1) or scope = 'firm')
          order by (scope = 'matter') desc
          limit 1`,
        [matterId],
      )
      if (pol.rowCount! > 0) {
        interestStatement = {
          annual_rate_pct: Number(pol.rows[0].annual_rate_pct),
          grace_days: pol.rows[0].grace_days as number,
        }
        const cap = await tx.query(
          `select d.body from deedbox.pack_declaration d
             join deedbox.firm f on f.id = $1
             join deedbox.country_pack cp on cp.id = f.country_pack
             join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
            where d.rule_point = 'billing.interest_cap'`,
          [p.firm],
        )
        for (const row of cap.rows) {
          const capPct = (row.body as { max_annual_rate_pct?: number }).max_annual_rate_pct
          if (capPct !== undefined && interestStatement.annual_rate_pct > capPct) {
            throw new OperationRefused(
              'interest_over_cap',
              `the stated rate ${interestStatement.annual_rate_pct}% exceeds the pack cap ${capPct}%`,
            )
          }
        }
      }
    }

    const details = await tx.query(`select to_jsonb(deedbox.governing_payment_details()) as d`)
    const governingDetails = details.rows[0].d

    // the firm's standing notice (0056), embedded as issued — a historic
    // bill keeps exactly the wording it went out with
    const noticeHeading = ((await settingText(tx, 'billing.bill_notice_heading')) ?? '').trim()
    const noticeText = ((await settingText(tx, 'billing.bill_notice')) ?? '').trim()
    const billNotice = noticeText ? { heading: noticeHeading || null, text: noticeText } : null

    const out: { id: number; billNumber: string; total: number }[] = []
    let siblingSum = 0
    for (const b of bills.rows) {
      const lines = await tx.query(
        `select id, kind, source_entry, description, amount, tax_amount, category_key
           from deedbox.bill_line where bill = $1 order by position`,
        [b.id],
      )
      if (lines.rowCount === 0) {
        throw new OperationRefused('empty_bill', `sibling ${b.id} has no lines`)
      }
      const total =
        Math.round(
          lines.rows.reduce((s, l) => s + Number(l.amount) + Number(l.tax_amount), 0) * 100,
        ) / 100
      siblingSum += total

      // the rendering, stored first; its reference is issued with the bill
      const rendering = {
        document: 'bill',
        payer_party: b.payer_party,
        issue_date: issueDate,
        terms_days: termsRaw,
        lines: lines.rows,
        total,
        interest_statement: interestStatement,
        payment_details: governingDetails,
        notice: billNotice,
      }
      const content = JSON.stringify(rendering)
      const hash = createHash('sha256').update(content).digest('hex')
      const artefact = await tx.query(
        `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
         values ('bill_rendering', $1, $2, 'application/json', $3) returning id`,
        [content, hash, Buffer.byteLength(content)],
      )
      const artefactRef = String(artefact.rows[0].id)

      // serialisation point 1: the gapless bill counter, inside this txn
      // numbered by the bill's ISSUE date (0051): a firm whose numbers carry the
      // date, or reset daily, gets the day the bill was issued — never the
      // database clock's day
      const num = await tx.query(`select deedbox.allocate_number('bill', null, $1::date) as n`, [issueDate])
      const billNumber = num.rows[0].n as string

      await tx.query(
        `update deedbox.bill
            set state = 'issued', bill_number = $2, issue_date = $3::date,
                terms_days_applied = $4::int, due_date = $3::date + $4::int,
                interest_statement = $5, rendered_artefact = $6
          where id = $1`,
        [
          b.id,
          billNumber,
          issueDate,
          termsRaw,
          interestStatement === null ? null : JSON.stringify(interestStatement),
          artefactRef,
        ],
      )
      // serialisation point 2: exactly one issue_total per sibling
      await tx.query(
        `insert into deedbox.bill_journal_entry
           (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
         values ($1, 'issue_total', $2, 'bill_issue', $1, $3::date, $4)`,
        [b.id, total, issueDate, p.id],
      )

      // default attribution: time/fixed-fee lines to the source entry's
      // staff pro-rata by line amount; disbursement and manual lines to the
      // responsible lawyer; largest-remainder handled by cent-rounding the
      // final share map
      const byStaff = new Map<number, number>()
      const responsible = await tx.query(
        `select responsible_lawyer from deedbox.matter where id = $1`,
        [matterId],
      )
      const respId = responsible.rows[0].responsible_lawyer as number
      for (const l of lines.rows) {
        let staffId = respId
        if ((l.kind === 'time' || l.kind === 'fixed_fee') && l.source_entry !== null) {
          const te = await tx.query(`select staff from deedbox.time_entry where id = $1`, [
            l.source_entry,
          ])
          if (te.rowCount! > 0) staffId = te.rows[0].staff as number
        }
        byStaff.set(staffId, (byStaff.get(staffId) ?? 0) + Number(l.amount) + Number(l.tax_amount))
      }
      let attributed = 0
      const entries = [...byStaff.entries()]
      for (let i = 0; i < entries.length; i++) {
        const isLast = i === entries.length - 1
        const share = isLast
          ? Math.round((total - attributed) * 100) / 100
          : Math.round(entries[i][1] * 100) / 100
        attributed = Math.round((attributed + share) * 100) / 100
        await tx.query(
          `insert into deedbox.bill_attribution (bill, staff, billed_share)
           values ($1, $2, $3)`,
          [b.id, entries[i][0], share],
        )
      }

      // a reminder state is born running where a default sequence exists,
      // first fire at due date + the first step's spacing
      await tx.query(
        `insert into deedbox.bill_reminder_state (bill, sequence, next_step_at)
         select $1, rs.id,
                ($2::date + $3::int)::timestamptz
                  + make_interval(days => (
                      select s.days_after_previous from deedbox.reminder_step s
                       where s.sequence = rs.id order by s.step_no limit 1))
           from deedbox.reminder_sequence rs
          where rs.default_for_new_bills and rs.active limit 1`,
        [b.id, issueDate, termsRaw],
      )

      // an ACTIVE covers-future arrangement of this client adopts the
      // new bill in the issuing transaction; its reminder is born stopped
      const adopt = await tx.query(
        `select a.id from deedbox.payment_arrangement a
          where a.state = 'active' and a.covers_future_bills
            and a.client_party = (select client_party from deedbox.matter where id = $1)
            and (a.matter is null or a.matter = $1)
          order by a.id limit 1`,
        [matterId],
      )
      if (adopt.rowCount! > 0) {
        await tx.query(
          `insert into deedbox.arrangement_bill (arrangement, bill) values ($1, $2)`,
          [adopt.rows[0].id, b.id],
        )
        await tx.query(
          `update deedbox.bill_reminder_state set status = 'stopped_arrangement'
            where bill = $1 and status = 'running'`,
          [b.id],
        )
        await emitRegister(tx, p, {
          kind: 'record.changed',
          subjectType: 'payment_arrangement',
          subject: adopt.rows[0].id as number,
          matter: matterId,
          detail: { future_bill_adopted: b.id },
        })
      }

      await emitRegister(tx, p, {
        kind: 'bill.issued',
        subjectType: 'bill',
        subject: b.id as number,
        matter: matterId,
        detail: { bill_number: billNumber, total },
      })
      out.push({ id: b.id as number, billNumber, total })
    }

    // group identity: Σ sibling totals = the group's recorded matter total,
    // to the cent (largest-remainder splitting makes this exact; write-downs
    // arrive with H2 and will carry the identity's written-down variant)
    const matterTotal = Number(g.rows[0].matter_total)
    if (Math.round(siblingSum * 100) !== Math.round(matterTotal * 100)) {
      throw new OperationRefused(
        'identity_broken',
        `sibling totals ${siblingSum.toFixed(2)} do not equal the matter total ${matterTotal.toFixed(2)}`,
      )
    }

    // the capture items on these bills are now billed
    for (const table of ['time_entry', 'disbursement'] as const) {
      await tx.query(
        `update deedbox.${table} i
            set billed_state = 'billed'
          where i.billed_state = 'on_draft'
            and i.bill_line in (
              select l.id from deedbox.bill_line l
               join deedbox.bill b on b.id = l.bill where b.bill_group = $1)`,
        [input.group],
      )
    }
    await tx.query(`update deedbox.bill_group set state = 'issued' where id = $1`, [input.group])
    return { bills: out }
  })
}
