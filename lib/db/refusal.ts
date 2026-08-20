import type { Principal, Tx, TxOptions } from './principal'
import { withPrincipal } from './principal'
import { emitRegister } from './register'
import { classifyMoneyRefusal, MoneyRefusal } from './errors'

/**
 * What was attempted, stated before the attempt — becomes the permanent
 * attempted_operation document if the attempt is refused.
 */
export interface MoneyAttempt {
  account: number
  matterLedger?: number
  /** The attempted-operation document, verbatim into jsonb. */
  operation: unknown
}

/**
 * The refusal-capture protocol. The defect it exists to prevent: a refusal
 * recorded inside the transaction it aborts self-destructs.
 *
 * Runs the operation body in transaction 1 via withPrincipal. If the
 * database refuses with a typed money reason (or the body throws
 * MoneyPreconditionFailed), transaction 1 is dead — so the capture opens
 * transaction 2 under the same principal and commits:
 *   1. the refused_operation row (permanent, typed), and
 *   2. its money.refusal_recorded register entry.
 * Then throws MoneyRefusal carrying the refusal row's id.
 *
 * Anything unclassifiable rethrows untouched and captures nothing: bugs and
 * outages are not refusals.
 */
export async function runMoneyOperation<T>(
  principal: Principal,
  attempt: MoneyAttempt,
  fn: (tx: Tx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  try {
    return await withPrincipal(principal, fn, opts)
  } catch (err) {
    const reason = classifyMoneyRefusal(err)
    if (!reason) throw err
    const message = err instanceof Error ? err.message : String(err)
    const refusalId = await withPrincipal(principal, async (tx) => {
      const r = await tx.query(
        `insert into deedbox.refused_operation
           (account, matter_ledger, attempted_operation, refusal_reason,
            attempted_by_kind, attempted_by)
         values ($1,$2,$3,$4,$5,$6)
         returning id`,
        [
          attempt.account,
          attempt.matterLedger ?? null,
          JSON.stringify({ operation: attempt.operation, message }),
          reason,
          principal.kind,
          principal.id,
        ],
      )
      const id = r.rows[0].id as number
      await emitRegister(tx, principal, {
        kind: 'money.refusal_recorded',
        subjectType: 'refused_operation',
        subject: id,
        detail: { reason, message },
      })
      return id
    })
    throw new MoneyRefusal(reason, message, refusalId)
  }
}
