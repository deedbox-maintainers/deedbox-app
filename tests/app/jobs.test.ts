// The jobs slice: the registry over the proven runners, the search-index
// rebuild fixpoint, the threshold sweep, the outbound transport seam, and
// the platform route's authentication.
//
// Cross-suite contract: runs after interface-outbound, before matters.
// Only inert-or-idempotent jobs execute here (cache recompute/verify,
// index rebuild, dormancy/close/stale sweeps — inert without pack
// declarations; outbound dispatch with an injected transport). The
// data-mutating sweeps (reminders, instalments, interest, remainders,
// threshold) are execution-proven by their own domains' suites; the route's
// 200 path resolves the ONE production firm and is exercised at the
// registry level here because the shared scratch hosts many test firms.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { runJob, setOutboundTransport, listJobs } from '@/lib/jobs/registry'
import { POST } from '@/app/api/jobs/[job]/route'
import { queueOutboundMessage } from '@/lib/ops/outbound'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'jobs')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
})

afterAll(async () => {
  setOutboundTransport(null)
  delete process.env.DEEDBOX_JOB_SECRET
  await closePool()
  await admin.end()
})

describe('the job registry', () => {
  it('refuses unknown jobs and lists the catalogue', async () => {
    await expect(runJob('no-such-job', fx.firm)).rejects.toMatchObject({ code: 'unknown_job' })
    expect(listJobs()).toContain('index-rebuild')
    expect(listJobs()).toContain('outbound-dispatch')
    expect(listJobs()).toContain('session-timeouts')
    expect(listJobs()).toContain('examiner-expiry')
    expect(listJobs()).toContain('anomaly-evaluation')
    expect(listJobs()).toContain('chain-verifier')
    expect(listJobs().length).toBe(24) // +set-aside-recalculation +document-text-extraction +m365-mail-poll +gl-sync +m365-filing-poll
  })

  it('outbound dispatch refuses until a transport is bound, then drains', async () => {
    await expect(runJob('outbound-dispatch', fx.firm)).rejects.toMatchObject({
      code: 'transport_unbound',
    })
    const q = await queueOutboundMessage(P, {
      channel: 'email',
      recipient: 'jobs@example.test',
      purpose: 'general_notice',
      content: 'jobs dispatch probe',
    })
    const delivered: number[] = []
    setOutboundTransport(async (m) => {
      delivered.push(m.id)
    })
    try {
      const outcome = (await runJob('outbound-dispatch', fx.firm)) as { sent: number; failed: number }
      expect(delivered).toContain(q.message)
      expect(outcome.sent).toBeGreaterThanOrEqual(1)
      const row = await admin.query(
        `select state from deedbox.outbound_message where id = $1`,
        [q.message],
      )
      expect(row.rows[0].state).toBe('sent')
    } finally {
      setOutboundTransport(null)
    }
  })

  it('recomputes and verifies the position cache, correcting seeded divergence', async () => {
    const first = (await runJob('cache-recompute', fx.firm)) as { recomputed: number }
    expect(first.recomputed).toBeGreaterThanOrEqual(1)
    const cached = await admin.query(
      `select unbilled_value from deedbox.matter_position_cache where matter = $1`,
      [fx.matter],
    )
    expect(cached.rowCount).toBe(1)
    // corrupt the row and push it to the front of the verifier's sample
    await admin.query(
      `update deedbox.matter_position_cache
          set unbilled_value = unbilled_value + 999, as_at_register_seq = 0
        where matter = $1`,
      [fx.matter],
    )
    const verified = (await runJob('cache-verify', fx.firm)) as {
      checked: number
      diverged: number[]
    }
    expect(verified.diverged).toContain(fx.matter)
    const healed = await admin.query(
      `select unbilled_value from deedbox.matter_position_cache where matter = $1`,
      [fx.matter],
    )
    expect(Number(healed.rows[0].unbilled_value)).toBe(Number(cached.rows[0].unbilled_value))
  })

  it('rebuilds the search index to a fixpoint, containment intact', async () => {
    const party = await admin.query(
      `insert into deedbox.party (kind, display_name) values ('person', 'Jobs Rebuild Person') returning id`,
    )
    const name = await admin.query(
      `insert into deedbox.party_name (party, name_kind, full_name)
       values ($1, 'current', 'Jobs Rebuild Person') returning id`,
      [party.rows[0].id],
    )
    // the feeder indexed it; simulate loss, then rebuild restores it
    await admin.query(`delete from deedbox.search_index where entry_type = 'party' and source = $1`, [
      name.rows[0].id,
    ])
    await runJob('index-rebuild', fx.firm)
    const restored = await admin.query(
      `select display_title from deedbox.search_index where entry_type = 'party' and source = $1`,
      [name.rows[0].id],
    )
    expect(restored.rows[0].display_title).toBe('Jobs Rebuild Person')

    // fixpoint: a second run leaves identical content
    const before = await admin.query(
      `select entry_type, source, coalesce(matter,0) m, display_title, body
         from deedbox.search_index order by entry_type, source`,
    )
    await runJob('index-rebuild', fx.firm)
    const after = await admin.query(
      `select entry_type, source, coalesce(matter,0) m, display_title, body
         from deedbox.search_index order by entry_type, source`,
    )
    expect(after.rows).toEqual(before.rows)

    // 0022's containment holds through a rebuild: no test party is indexed
    const testLeak = await admin.query(
      `select count(*)::int as n from deedbox.search_index si
        join deedbox.party_name pn on pn.id = si.source and si.entry_type = 'party'
        join deedbox.party p on p.id = pn.party
       where p.test`,
    )
    expect(testLeak.rows[0].n).toBe(0)
  })

  it('pack-gated sweeps run inert without declarations', async () => {
    const dormancy = (await runJob('dormancy-detection', fx.firm)) as { opened: unknown[] }
    expect(dormancy.opened).toEqual([])
    const closes = (await runJob('close-materialiser', fx.firm)) as { created: unknown[] }
    expect(closes.created).toEqual([])
    const stale = (await runJob('stale-instruments', fx.firm)) as { staled: unknown[] }
    expect(Array.isArray(stale.staled)).toBe(true)
  })
})

describe('the platform route', () => {
  const call = (job: string, headers: Record<string, string> = {}) =>
    POST(new Request(`http://localhost/api/jobs/${job}`, { method: 'POST', headers }), {
      params: Promise.resolve({ job }),
    })

  it('is disabled without configuration, refuses bad secrets, 404s unknown jobs', async () => {
    delete process.env.DEEDBOX_JOB_SECRET
    expect((await call('cache-verify')).status).toBe(503)

    process.env.DEEDBOX_JOB_SECRET = 'jobs-test-secret'
    expect((await call('cache-verify')).status).toBe(401)
    expect((await call('cache-verify', { 'x-job-secret': 'wrong' })).status).toBe(401)

    const notFound = await call('no-such-job', { 'x-job-secret': 'jobs-test-secret' })
    expect(notFound.status).toBe(404)
    const body = (await notFound.json()) as { error: string }
    expect(body.error).toBe('unknown_job')
  })
})
