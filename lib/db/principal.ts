import type { PoolClient } from 'pg'
import { getPool } from './pool'

// The five principal kinds the visibility predicate recognises (0005).
export type PrincipalKind =
  | 'staff'
  | 'portal_client'
  | 'system_job'
  | 'integration_key'
  | 'examiner'

export interface Principal {
  kind: PrincipalKind
  /** staff_member id / party id / job registry id / integration key id / examiner grant id */
  id: number
  /** The firm whose register receives this work's entries. */
  firm: number
  /** Terminal session id — staff principals only; lands on register entries. */
  session?: number
}

// Per-transaction ceremony flags. Each guard compares to the literal 'on'.
// A ceremony is requested by the ONE operation that is the ceremony — never
// ambiently. (deedbox.estimate_maintenance is set by the revision trigger
// itself and is deliberately absent here.)
export type CeremonyFlag = 'edit_closed' | 'explicit_money_grant'

export interface TxOptions {
  readOnly?: boolean
  ceremonies?: CeremonyFlag[]
}

// What an operation body receives: query only. Transaction control belongs
// to withPrincipal alone — an operation must never commit, roll back, or
// touch session state.
export type Tx = Pick<PoolClient, 'query'>

/**
 * The single doorway to the database.
 *
 * One call = one transaction:
 *   begin [read only]
 *   set local role deedbox_app            -- grants + row security now apply
 *   set_config(principal kind/id, local)  -- the predicate's context
 *   [ceremony flags, local]
 *   ...fn...
 *   commit
 *
 * Everything is `set local`, so the pattern is identical and correct under
 * session pooling, transaction pooling and direct connections; no session
 * state can leak between requests. Absent context fails closed at the
 * predicate (0005) — but this wrapper always supplies it.
 */
export async function withPrincipal<T>(
  principal: Principal,
  fn: (tx: Tx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query(opts.readOnly ? 'begin read only' : 'begin')
    await client.query('set local role deedbox_app')
    await client.query(
      "select set_config('deedbox.principal_kind', $1, true), set_config('deedbox.principal_id', $2, true)",
      [principal.kind, String(principal.id)],
    )
    for (const flag of opts.ceremonies ?? []) {
      await client.query(`select set_config('deedbox.${flag}', 'on', true)`)
    }
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    try {
      await client.query('rollback')
    } catch {
      // the connection may already be gone; release() below cleans up
    }
    throw err
  } finally {
    client.release()
  }
}
