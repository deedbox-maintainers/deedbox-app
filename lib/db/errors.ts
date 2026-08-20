// Typed refusals the screens can render honestly.

/**
 * A non-money refusal: a precondition failed, or a schema guard refused.
 * Nothing was written — a refused precondition aborts with a typed message
 * and writes nothing.
 */
export class OperationRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OperationRefused'
  }
}

/** The typed reasons of refused_operation.refusal_reason (0012). */
export type MoneyRefusalReason =
  | 'would_go_below_zero'
  | 'period_locked'
  | 'earmark_shortfall'
  | 'entitlement_missing'
  | 'notice_not_elapsed'
  | 'method_unavailable'
  | 'authorisation_missing'
  | 'integrity_refusal'

/**
 * A refused money operation, AFTER its capture: the refusal row and its
 * money.refusal_recorded register entry exist in their own committed
 * transaction. refusalId points at the refused_operation row.
 */
export class MoneyRefusal extends Error {
  constructor(
    readonly reason: MoneyRefusalReason,
    message: string,
    readonly refusalId: number,
  ) {
    super(message)
    this.name = 'MoneyRefusal'
  }
}

/**
 * Thrown by operation code for an app-level money precondition that the
 * refusal register must still capture (e.g. a pack-declared payment method being
 * unavailable — no schema guard exists for it, but the refusal is evidence).
 * runMoneyOperation converts it into a captured MoneyRefusal.
 */
export class MoneyPreconditionFailed extends Error {
  constructor(
    readonly reason: MoneyRefusalReason,
    message: string,
  ) {
    super(message)
    this.name = 'MoneyPreconditionFailed'
  }
}

/**
 * Map a database guard's raised message to its typed refusal reason.
 * Conservative on purpose: only messages the schema demonstrably raises are
 * classified; anything else (bugs, connectivity, constraint noise) returns
 * null and is NOT captured as a refusal.
 *
 * Sources: 0012 (line guard, authorisation guard), 0013 (earmark coverage,
 * entitlement actionability/headroom), 0014 (the period lock).
 */
export function classifyMoneyRefusal(err: unknown): MoneyRefusalReason | null {
  if (err instanceof MoneyPreconditionFailed) return err.reason
  const m = err instanceof Error ? err.message : ''
  if (/would go below zero/.test(m)) return 'would_go_below_zero'
  if (/period_locked/.test(m)) return 'period_locked'
  if (/earmark shortfall|active earmarks would exceed/.test(m)) return 'earmark_shortfall'
  if (/found notice_running/.test(m)) return 'notice_not_elapsed'
  if (/actionable entitlement|entitlement's remaining headroom|rests on an ISSUED/.test(m))
    return 'entitlement_missing'
  if (/requires its authorisation row|only on an approved authorisation|authorisation needs \d+ approvals/.test(m))
    return 'authorisation_missing'
  return null
}
