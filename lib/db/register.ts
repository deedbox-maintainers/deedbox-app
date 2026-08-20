import type { Principal, Tx } from './principal'

/**
 * One register entry, as the emitting operation states it. The append trigger
 * (0001, hardened 0003) assigns seq and the hash chain, enforces the
 * privileged before/after rule, reason-required kinds and matter-link rules —
 * a violation aborts the whole surrounding transaction, which is deliberate:
 * no business change may commit unrecorded.
 */
export interface RegisterEvent {
  /** A kind from the register_event_kind catalogue (54 kinds, 0001). */
  kind: string
  subjectType: string
  subject: number
  matter?: number
  privileged?: boolean
  /** jsonb detail; privileged entries must carry { before, after }. */
  detail?: unknown
  reason?: string
  bulkOperation?: number
  artefact?: string
}

/**
 * Append one register entry inside the caller's transaction.
 *
 * Lock-order duty: the chain-head lock this insert takes is
 * LAST in the canonical order (ledger locks ascending → bill locks →
 * numbering counters → chain head). Call emitRegister at the END of an
 * operation body, after every business write.
 */
export async function emitRegister(
  tx: Tx,
  principal: Principal,
  event: RegisterEvent,
): Promise<number> {
  const r = await tx.query(
    `insert into deedbox.register_entry
       (firm, actor_kind, actor, session_ref, event_kind, subject_type,
        subject, matter, privileged, detail, reason, bulk_operation, artefact)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning id`,
    [
      principal.firm,
      principal.kind,
      principal.id,
      principal.session ?? null,
      event.kind,
      event.subjectType,
      event.subject,
      event.matter ?? null,
      event.privileged ?? false,
      event.detail === undefined ? null : JSON.stringify(event.detail),
      event.reason ?? null,
      event.bulkOperation ?? null,
      event.artefact ?? null,
    ],
  )
  return r.rows[0].id as number
}
