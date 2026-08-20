import { Pool, types } from 'pg'

// Identity columns are bigint. Their values in any real firm's lifetime sit
// far below 2^53, so parse int8 as a JS number — one numeric type everywhere
// beats string/number comparison bugs across the operations layer.
types.setTypeParser(types.builtins.INT8, (v) => Number(v))

let pool: Pool | undefined

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DEEDBOX_DATABASE_URL
    if (!url) throw new Error('DEEDBOX_DATABASE_URL is not set')
    pool = new Pool({
      connectionString: url,
      max: Number(process.env.DEEDBOX_POOL_MAX ?? 10),
      // Hosted Postgres requires TLS. Certificate pinning is a further
      // deployment hardening step: supply the CA and flip rejectUnauthorized.
      ssl:
        process.env.DEEDBOX_DATABASE_SSL === 'disable'
          ? undefined
          : { rejectUnauthorized: false },
    })
  }
  return pool
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = undefined
  }
}
