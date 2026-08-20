import { getPool } from './pool'

// One database = one firm (the schema scopes the register and settings by
// firm; the business tables carry none). The id is resolved once and cached
// for the process's life.
//
// The two failure shapes are DIFFERENT FACTS and callers must not conflate
// them: a database that cannot be reached right now (FirmUnreachable — retry,
// the instance is fine) versus a database that answered and holds no firm
// (FirmMissing — the instance genuinely is not initialised). Conflating them
// told signed-in people "no firm exists yet" during momentary connection
// pressure (found on a firm's first day live).
let firmId: number | undefined

export class FirmUnreachable extends Error {
  constructor(cause: unknown) {
    super('the database could not be reached to resolve the firm')
    this.cause = cause
  }
}

export class FirmMissing extends Error {
  constructor(count: number) {
    super(`expected exactly one firm row, found ${count} — this instance is not initialised`)
  }
}

export async function theFirm(): Promise<number> {
  if (firmId === undefined) {
    let r
    try {
      r = await getPool().query('select id from deedbox.firm order by id')
    } catch (err) {
      throw new FirmUnreachable(err)
    }
    if (r.rowCount !== 1) {
      throw new FirmMissing(r.rowCount ?? 0)
    }
    firmId = r.rows[0].id as number
  }
  return firmId
}

/** Test seam: forget the cached firm (a fresh scratch database has a fresh id). */
export function resetFirmCache(): void {
  firmId = undefined
}
