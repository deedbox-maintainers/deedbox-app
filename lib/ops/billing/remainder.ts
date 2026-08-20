// Unallocated-remainder routing (system job). The engine default compels
// nothing: remainders stay as visible credit. Where the active pack
// declares `money.unallocated_routing`, remainders that match are moved to
// client money in ONE bridge transaction per payment: the office side
// derives-cancels the payment with a correcting mirror (reason: routed),
// and the client-money side posts the receipt against the client's matter
// ledger — both commit together or neither does, exactly as the held-funds
// bridge. Per-item refusals are captured by runMoneyOperation where they
// are posting refusals, leave the remainder untouched, and are itemised on
// the job's report.
//
// Implementation notes: only FULLY-unallocated payments route —
// a partially-allocated remainder is a human decision, itemised as skipped;
// the declaration body is {after_days, min_amount}; the routing home must
// resolve to exactly one open client ledger among the matters where the
// payer holds the client capacity, else the payment is skipped with the
// reason; the posting's entered_by falls back to the home matter's
// issue-side author when the job principal is not staff (the matter table
// is predicate-bound; matter_party and the journal are not).

import type { Principal, Tx } from '@/lib/db'
import {
  withPrincipal,
  emitRegister,
  OperationRefused,
  runMoneyOperation,
  MoneyRefusal,
} from '@/lib/db'
import { createHash } from 'node:crypto'

interface RoutingRule {
  afterDays: number
  minAmount: number
}

export async function routeUnallocatedRemainders(p: Principal): Promise<{
  routed: { payment: number; amount: number; receipt: number }[]
  skipped: { payment: number; reason: string }[]
}> {
  const routed: { payment: number; amount: number; receipt: number }[] = []
  const skipped: { payment: number; reason: string }[] = []

  const scope = await withPrincipal(
    p,
    async (tx) => {
      const decl = await tx.query(
        `select d.body from deedbox.pack_declaration d
           join deedbox.firm f on f.id = $1
           join deedbox.country_pack cp on cp.id = f.country_pack
           join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
          where d.rule_point = 'money.unallocated_routing'`,
        [p.firm],
      )
      let rule: RoutingRule | null = null
      for (const row of decl.rows) {
        const b = row.body as { after_days?: number; min_amount?: number }
        if (b.after_days !== undefined) {
          rule = { afterDays: b.after_days, minAmount: b.min_amount ?? 0 }
        }
      }
      if (!rule) return null // the engine default: nothing is compelled
      const candidates = await tx.query(
        `select rp.id, rp.amount, rp.payer_party, rp.method
           from deedbox.receivable_payment rp
          where rp.reverses is null
            and not exists (select 1 from deedbox.receivable_payment m where m.reverses = rp.id)
            and rp.entered_at < now() - make_interval(days => $1::int)
            and rp.amount >= $2::numeric
            and not exists (
              select 1 from deedbox.bill_journal_entry j
               where j.source_type = 'receivable_payment' and j.source = rp.id
                 and j.entry_kind in ('payment_allocation','reversal'))
          order by rp.id`,
        [rule.afterDays, rule.minAmount],
      )
      return { candidates: candidates.rows }
    },
    { readOnly: true },
  )
  if (!scope) return { routed, skipped }

  for (const cand of scope.candidates) {
    const paymentId = cand.id as number
    try {
      // resolve the routing home outside the money transaction so a
      // resolution failure is a plain skip, not a captured refusal
      const home = await withPrincipal(
        p,
        async (tx) => {
          if (cand.payer_party === null) {
            throw new OperationRefused('unknown_payer', 'the payment names no payer')
          }
          const homes = await tx.query(
            `select ml.id as ledger, ml.account, ml.matter,
                    (select j.entered_by from deedbox.bill_journal_entry j
                      join deedbox.bill b on b.id = j.bill
                     where b.matter = ml.matter and j.entry_kind = 'issue_total'
                     order by j.id limit 1) as accountable
               from deedbox.matter_ledger ml
               join deedbox.matter_party mp
                 on mp.matter = ml.matter and mp.party = $1 and mp.deleted_at is null
               join deedbox.choice_item ci
                 on ci.id = mp.capacity and ci.shipped_key = 'client'
              where ml.ledger_kind = 'client_matter' and ml.status = 'open'`,
            [cand.payer_party],
          )
          if (homes.rowCount !== 1) {
            throw new OperationRefused(
              'no_single_home',
              `the payer holds ${homes.rowCount} open client ledgers — routing needs exactly one`,
            )
          }
          const h = homes.rows[0]
          const enteredBy = p.kind === 'staff' ? p.id : (h.accountable as number | null)
          if (enteredBy === null) {
            throw new OperationRefused('no_accountable_staff', 'no issue evidence names a staff member')
          }
          return {
            ledger: h.ledger as number,
            account: h.account as number,
            matter: h.matter as number,
            enteredBy,
          }
        },
        { readOnly: true },
      )
      const result = await runMoneyOperation(
        p,
        { account: home.account, matterLedger: home.ledger, operation: 'remainder_routing' },
        (tx) =>
          routeOneInTx(
            tx,
            p,
            paymentId,
            Number(cand.amount),
            cand.method as string,
            cand.payer_party as number,
            home.ledger,
            home.account,
            home.matter,
            home.enteredBy,
          ),
      )
      routed.push(result)
    } catch (e) {
      if (e instanceof OperationRefused || e instanceof MoneyRefusal) {
        skipped.push({ payment: paymentId, reason: e.message })
      } else {
        throw e
      }
    }
  }
  return { routed, skipped }
}

async function routeOneInTx(
  tx: Tx,
  p: Principal,
  paymentId: number,
  amount: number,
  method: string,
  payerParty: number,
  ledger: number,
  account: number,
  matter: number,
  enteredBy: number,
): Promise<{ payment: number; amount: number; receipt: number }> {
  // per-payment advisory serialisation (append-only rows never row-lock),
  // then the ledger lock — the canonical order's ledger family
  await tx.query(`select pg_advisory_xact_lock(4201, $1::int)`, [paymentId])
  const fresh = await tx.query(
    `select 1 from deedbox.receivable_payment rp
      where rp.id = $1 and rp.reverses is null
        and not exists (select 1 from deedbox.receivable_payment m where m.reverses = rp.id)
        and not exists (
          select 1 from deedbox.bill_journal_entry j
           where j.source_type = 'receivable_payment' and j.source = rp.id
             and j.entry_kind in ('payment_allocation','reversal'))`,
    [paymentId],
  )
  if (fresh.rowCount === 0) {
    throw new OperationRefused('state_moved', 'the payment was allocated or corrected meanwhile')
  }
  await tx.query(`select id from deedbox.matter_ledger where id = $1 for update`, [ledger])

  // the client-money side: post the receipt
  const txn = await tx.query(
    `select deedbox.post_money_transaction(
       'receipt', current_date, $1, 'receivable_payment', $2,
       jsonb_build_array(
         jsonb_build_object('side','cash_book','account',$3::bigint,'signed_amount',$4::numeric),
         jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$5::bigint,'signed_amount',$4::numeric)
       )) as t`,
    [enteredBy, paymentId, account, amount, ledger],
  )
  const rNum = await tx.query(`select deedbox.allocate_number('money_receipt') as n`)
  const rendering = JSON.stringify({
    document: 'money_receipt',
    receipt_number: rNum.rows[0].n,
    amount,
    method,
    routed_from_payment: paymentId,
  })
  const artefact = await tx.query(
    `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
     values ('money_receipt_rendering', $1, $2, 'application/json', $3) returning id`,
    [rendering, createHash('sha256').update(rendering).digest('hex'), Buffer.byteLength(rendering)],
  )
  const receipt = await tx.query(
    `insert into deedbox.money_receipt
       (matter_ledger, receipt_number, payer_party, method, received_date, amount,
        transaction, printable_artefact)
     values ($1, $2, $3, $4, current_date, $5, $6, $7) returning id`,
    [ledger, rNum.rows[0].n, payerParty, method, amount, txn.rows[0].t, String(artefact.rows[0].id)],
  )

  // the office side: the correcting mirror consumes the remainder, derived
  const orNum = await tx.query(`select deedbox.allocate_number('receivable_receipt') as n`)
  const mirror = await tx.query(
    `insert into deedbox.receivable_payment
       (received_date, amount, method, receipt_number, reverses, reason)
     select received_date, amount, method, $2, id, $3
       from deedbox.receivable_payment where id = $1
     returning id`,
    [paymentId, orNum.rows[0].n, 'remainder routed to client money per pack rule'],
  )

  await emitRegister(tx, p, {
    kind: 'record.changed',
    subjectType: 'receivable_payment',
    subject: paymentId,
    matter,
    reason: 'remainder routed to client money per pack rule',
    detail: {
      routed_amount: amount,
      money_receipt: receipt.rows[0].id,
      mirror: mirror.rows[0].id,
    },
  })
  await emitRegister(tx, p, {
    kind: 'money.transaction_posted',
    subjectType: 'money_transaction',
    subject: txn.rows[0].t as number,
    matter,
    detail: { kind: 'receipt', amount, receipt_number: rNum.rows[0].n, routed_from: paymentId },
  })
  return { payment: paymentId, amount, receipt: receipt.rows[0].id as number }
}
