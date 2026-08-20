// Instrument transitions and the stale sweep job. Presentation and clearing
// belong to reconciliation certification (the recon slice); this module
// walks the other verbs: inbound banked; dishonour — posted on the BANK'S
// authority as a system reversal with no authorisation row, excess earmarks
// auto-releasing, and a partial dishonour being exactly a full reversal
// plus a fresh receipt of the honoured part in one transaction; outbound
// cancellation — a staff reversal of an authorised kind, so it demands its
// approved authorisation row; replacement linkage after a fresh payment has
// executed; and the daily stale sweep.
//
// Implementation note: the dishonour posting flips the per-transaction
// principal flag to system_job for the posting statements — the bank's act
// is the authority (the trigger's earmark auto-release and no-authorisation
// exemptions key on it) — while the register entry records the recording
// staff member honestly.

import type { Principal, Tx } from '@/lib/db'
import {
  withPrincipal,
  emitRegister,
  OperationRefused,
  runMoneyOperation,
} from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'

async function loadInstrument(tx: Tx, id: number, lock = true) {
  const r = await tx.query(
    `select i.id, i.account, i.direction, i.instrument_kind, i.number, i.amount, i.state,
            i.source_type, i.source, i.transaction,
            (select l.matter_ledger from deedbox.ledger_line l
              where l.transaction = i.transaction and l.matter_ledger is not null limit 1) as ledger,
            (select ml.matter from deedbox.ledger_line l
              join deedbox.matter_ledger ml on ml.id = l.matter_ledger
             where l.transaction = i.transaction and l.matter_ledger is not null limit 1) as matter
       from deedbox.instrument i where i.id = $1 ${lock ? 'for update of i' : ''}`,
    [id],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'instrument not found')
  return r.rows[0] as {
    id: number
    account: number
    direction: string
    instrument_kind: string
    number: string
    amount: string
    state: string
    source_type: string
    source: number
    transaction: number
    ledger: number | null
    matter: number | null
  }
}

/** An inbound instrument is banked. */
export async function bankInstrument(
  p: Principal,
  input: { instrument: number; depositEvidence?: string },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const inst = await loadInstrument(tx, input.instrument)
    if (inst.direction !== 'inbound' || inst.state !== 'received') {
      throw new OperationRefused('wrong_state', `a ${inst.direction} instrument in ${inst.state} cannot bank`)
    }
    await tx.query(
      `update deedbox.instrument set state = 'banked', state_changed_at = now() where id = $1`,
      [input.instrument],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'instrument',
      subject: input.instrument,
      matter: inst.matter ?? undefined,
      detail: {
        before: { state: 'received' },
        after: { state: 'banked' },
        deposit_evidence: input.depositEvidence ?? null,
      },
    })
  })
}

/**
 * Dishonour, on the bank's authority. Reverses the receipt's
 * transaction as the system (no authorisation row; excess earmarks
 * auto-release); a partial dishonour writes the fresh receipt of the
 * honoured part in the same transaction. A dishonour the below-zero rule
 * refuses is a detected shortfall: captured to the refusal register,
 * promotable to an incident.
 */
export async function dishonourInstrument(
  p: Principal,
  input: { instrument: number; bankEvidence: string; honouredAmount?: number },
): Promise<{ reversal: number; freshReceipt: number | null }> {
  requireStaff(p)
  if (!input.bankEvidence.trim()) {
    throw new OperationRefused('evidence_required', 'a dishonour carries the bank evidence')
  }
  const scope = await withPrincipal(
    p,
    (tx) => loadInstrument(tx, input.instrument, false),
    { readOnly: true },
  )
  if (scope.direction !== 'inbound' || (scope.state !== 'banked' && scope.state !== 'received')) {
    throw new OperationRefused('wrong_state', `a ${scope.state} instrument cannot dishonour`)
  }
  const honoured = input.honouredAmount ?? 0
  const full = Math.round(Number(scope.amount) * 100)
  if (honoured < 0 || Math.round(honoured * 100) >= full) {
    if (honoured !== 0) {
      throw new OperationRefused('bad_amount', 'the honoured part sits below the instrument amount')
    }
  }
  return runMoneyOperation(
    p,
    { account: scope.account, matterLedger: scope.ledger ?? undefined, operation: 'instrument_dishonour' },
    async (tx) => {
      await requireCapability(tx, p, 'money.manage_accounts')
      const inst = await loadInstrument(tx, input.instrument)
      if (inst.direction !== 'inbound' || (inst.state !== 'banked' && inst.state !== 'received')) {
        throw new OperationRefused('wrong_state', `a ${inst.state} instrument cannot dishonour`)
      }
      // the bank's act is the authority: the posting runs as the system
      await tx.query(`select set_config('deedbox.principal_kind', 'system_job', true)`)
      const lines = await tx.query(
        `select side, account, matter_ledger, signed_amount from deedbox.ledger_line
          where transaction = $1 order by id`,
        [inst.transaction],
      )
      const mirrored = lines.rows.map((l) => ({
        side: l.side,
        account: l.account,
        matter_ledger: l.matter_ledger,
        signed_amount: -Number(l.signed_amount),
      }))
      const reversal = await tx.query(
        `select deedbox.post_money_transaction(
           'reversal', current_date, $1, 'instrument', $2, $3::jsonb, $4, null, $5) as t`,
        [
          p.id,
          input.instrument,
          JSON.stringify(mirrored),
          `bank dishonour: ${input.bankEvidence}`,
          inst.transaction,
        ],
      )
      let freshReceipt: number | null = null
      if (honoured > 0 && inst.ledger !== null) {
        // the partial shape: full reversal plus a fresh receipt of the
        // honoured part, its own number and document, in this transaction
        const num = await tx.query(`select deedbox.allocate_number('money_receipt') as n`)
        const seq = Number((num.rows[0].n as string).replace(/^\D+/, ''))
        const freshTxn = await tx.query(
          `select deedbox.post_money_transaction(
             'receipt', current_date, $1, 'money_receipt_number', $2,
             jsonb_build_array(
               jsonb_build_object('side','cash_book','account',$3::bigint,'signed_amount',$4::numeric),
               jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$5::bigint,'signed_amount',$4::numeric)
             )) as t`,
          [p.id, seq, inst.account, honoured, inst.ledger],
        )
        const rendering = JSON.stringify({
          document: 'money_receipt',
          receipt_number: num.rows[0].n,
          amount: honoured,
          method: inst.instrument_kind,
          honoured_part_of_dishonour: input.instrument,
        })
        const artefact = await tx.query(
          `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
           values ('money_receipt_rendering', $1, $2, 'application/json', $3) returning id`,
          [rendering, createHash('sha256').update(rendering).digest('hex'), Buffer.byteLength(rendering)],
        )
        const source = await tx.query(
          `select payer_party, payer_description from deedbox.money_receipt where id = $1`,
          [inst.source_type === 'money_receipt' ? inst.source : -1],
        )
        const fresh = await tx.query(
          `insert into deedbox.money_receipt
             (matter_ledger, receipt_number, payer_party, payer_description, method,
              received_date, amount, transaction, printable_artefact)
           values ($1, $2, $3, $4, $5, current_date, $6, $7, $8) returning id`,
          [
            inst.ledger,
            num.rows[0].n,
            source.rowCount! > 0 ? source.rows[0].payer_party : null,
            source.rowCount! > 0 ? source.rows[0].payer_description : 'honoured part of dishonoured instrument',
            inst.instrument_kind,
            honoured,
            freshTxn.rows[0].t,
            String(artefact.rows[0].id),
          ],
        )
        freshReceipt = fresh.rows[0].id as number
      }
      // restore the actor's own principal for the state change + register
      await tx.query(`select set_config('deedbox.principal_kind', $1, true)`, [p.kind])
      await tx.query(
        `update deedbox.instrument
            set state = 'dishonoured', state_changed_at = now(), dishonour_reversal = $2
          where id = $1`,
        [input.instrument, reversal.rows[0].t],
      )
      await emitRegister(tx, p, {
        kind: 'money.transaction_posted',
        subjectType: 'money_transaction',
        subject: reversal.rows[0].t as number,
        matter: inst.matter ?? undefined,
        reason: `bank dishonour: ${input.bankEvidence}`,
        detail: {
          kind: 'reversal',
          instrument: input.instrument,
          honoured_amount: honoured > 0 ? honoured : null,
          fresh_receipt: freshReceipt,
        },
      })
      return { reversal: reversal.rows[0].t as number, freshReceipt }
    },
  )
}

/**
 * Cancel an outbound instrument: the cancellation reversal posts
 * in the same transaction. The reversed kind is a payment, so an approved
 * authorisation row (subject_type reversal) is required.
 */
export async function cancelInstrument(
  p: Principal,
  input: { instrument: number; reason: string; authorisation: number },
): Promise<{ reversal: number }> {
  requireStaff(p)
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a cancellation carries its reason')
  const scope = await withPrincipal(
    p,
    (tx) => loadInstrument(tx, input.instrument, false),
    { readOnly: true },
  )
  return runMoneyOperation(
    p,
    { account: scope.account, matterLedger: scope.ledger ?? undefined, operation: 'instrument_cancel' },
    async (tx) => {
      await requireCapability(tx, p, 'money.manage_accounts')
      const inst = await loadInstrument(tx, input.instrument)
      if (inst.direction !== 'outbound' || (inst.state !== 'created' && inst.state !== 'stale')) {
        throw new OperationRefused('wrong_state', `a ${inst.state} instrument cannot cancel`)
      }
      const lines = await tx.query(
        `select side, account, matter_ledger, signed_amount from deedbox.ledger_line
          where transaction = $1 order by id`,
        [inst.transaction],
      )
      const mirrored = lines.rows.map((l) => ({
        side: l.side,
        account: l.account,
        matter_ledger: l.matter_ledger,
        signed_amount: -Number(l.signed_amount),
      }))
      const reversal = await tx.query(
        `select deedbox.post_money_transaction(
           'reversal', current_date, $1, 'instrument', $2, $3::jsonb, $4, $5, $6) as t`,
        [
          p.id,
          input.instrument,
          JSON.stringify(mirrored),
          input.reason,
          input.authorisation,
          inst.transaction,
        ],
      )
      await tx.query(
        `update deedbox.instrument
            set state = 'cancelled', state_changed_at = now(), cancellation_reversal = $2
          where id = $1`,
        [input.instrument, reversal.rows[0].t],
      )
      await emitRegister(tx, p, {
        kind: 'money.transaction_posted',
        subjectType: 'money_transaction',
        subject: reversal.rows[0].t as number,
        matter: inst.matter ?? undefined,
        reason: input.reason,
        detail: { kind: 'reversal', cancelled_instrument: input.instrument },
      })
      return { reversal: reversal.rows[0].t as number }
    },
  )
}

/** Link a replacement after the fresh payment's instrument exists. */
export async function linkReplacementInstrument(
  p: Principal,
  input: { cancelled: number; replacement: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_accounts')
    const old = await loadInstrument(tx, input.cancelled)
    if (old.state !== 'cancelled') {
      throw new OperationRefused('wrong_state', 'only a cancelled instrument takes a replacement')
    }
    const fresh = await loadInstrument(tx, input.replacement)
    if (fresh.direction !== 'outbound' || fresh.state !== 'created') {
      throw new OperationRefused('wrong_state', 'the replacement is a freshly created outbound instrument')
    }
    await tx.query(
      `update deedbox.instrument set replaced_by = $2, state = 'replaced', state_changed_at = now()
        where id = $1`,
      [input.cancelled, input.replacement],
    )
    await tx.query(`update deedbox.instrument set replaces = $2 where id = $1`, [
      input.replacement,
      input.cancelled,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'instrument',
      subject: input.cancelled,
      matter: old.matter ?? undefined,
      detail: { before: { state: 'cancelled' }, after: { state: 'replaced', replaced_by: input.replacement } },
    })
  })
}

/** The daily stale sweep (system job body). */
export async function runStaleInstrumentSweep(p: Principal): Promise<{ staled: number[] }> {
  const due = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select id from deedbox.instrument
          where direction = 'outbound' and state = 'created'
            and stale_after < (now() at time zone (select timezone from deedbox.firm order by id limit 1))::date
          order by id`,
      )
      return r.rows.map((x) => x.id as number)
    },
    { readOnly: true },
  )
  const staled: number[] = []
  for (const id of due) {
    await withPrincipal(p, async (tx) => {
      const inst = await loadInstrument(tx, id)
      if (inst.state !== 'created') return
      await tx.query(
        `update deedbox.instrument set state = 'stale', state_changed_at = now() where id = $1`,
        [id],
      )
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'instrument',
        subject: id,
        matter: inst.matter ?? undefined,
        detail: { before: { state: 'created' }, after: { state: 'stale' } },
      })
      staled.push(id)
    })
  }
  return { staled }
}
