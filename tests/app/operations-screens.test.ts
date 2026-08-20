// Operations/experience screens, second part: the report catalogue and
// viewer layers (save, export, schedule), the schedule manager over a real
// scheduled send, targets, the import wizard's batch and detail reads,
// integration keys, the outbound log and search.
//
// Cross-suite contracts (localeCompare order: after money-screens, before
// plumbing): fixture rows are tag-named (zops); the import batch's source
// system is its own name (ZopsLegacy) so source-reference assertions never
// meet another suite's; the schedule created here belongs to this fixture's
// staff and fires once via runDueSchedules with rows scoped to it; NO
// database-global setting is flipped.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  saveReport,
  exportReport,
  createReportSchedule,
  setSchedulePaused,
  runDueSchedules,
  replaceTargets,
  search,
} from '@/lib/ops/reports'
import { runImportBatch } from '@/lib/ops/imports'
import { issueIntegrationKey, revokeIntegrationKey } from '@/lib/ops/interface'
import {
  reportCatalogue,
  scheduleManager,
  targetsScreen,
  importScreens,
  importBatchDetail,
  keysScreen,
  keyDetail,
  outboundLog,
  reportViewerContext,
} from '@/lib/reads/operations'
// the person's own devices & sessions read is the security read layer's —
// the /account screen consumes it there; this suite exercises the same one
import { myDevicesAndSessions } from '@/lib/reads/security'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
const JOBP = (): Principal => ({ kind: 'system_job', id: 11, firm: fx.firm })

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'zops')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('the report catalogue and its layers', () => {
  it('the shipped catalogue is never empty and saving adds a personal row', async () => {
    let cat = await reportCatalogue(P)
    expect(cat.definitions.length).toBeGreaterThanOrEqual(5)
    const saved = await saveReport(P, {
      key: 'matter_list_financials',
      name: 'My matters zops',
      shared: false,
    })
    cat = await reportCatalogue(P)
    expect(cat.saved.some((s) => s.id === saved.id && s.name === 'My matters zops')).toBe(true)
  })

  it('an export stores the artefact and is registered with its count', async () => {
    const r = await exportReport(P, { key: 'matter_list_financials', format: 'csv' })
    expect(r.artefact).toBeGreaterThan(0)
    const evt = await admin.query(
      `select privileged, detail from deedbox.register_entry
        where event_kind = 'export.performed' and artefact = $1`,
      [String(r.artefact)],
    )
    expect(evt.rowCount).toBe(1)
    expect(evt.rows[0].privileged).toBe(true)
    expect(
      (evt.rows[0].detail as { after?: { restricted_matters?: number } })?.after
        ?.restricted_matters,
    ).toBeDefined()
  })

  it('a schedule fires: each recipient gets their own predicate-bound copy on the outbound log', async () => {
    const s = await createReportSchedule(P, {
      reportKind: 'standard',
      report: 'matter_list_financials',
      period: { every: 'week' },
      format: 'csv',
      recipients: [{ staff: fx.staff }],
      firstRunAt: new Date(Date.now() - 60_000).toISOString(),
    })
    let mgr = await scheduleManager(P)
    const mine = mgr.schedules.find((x) => x.id === s.id)
    expect(mine).toBeDefined()
    expect(mine!.recipients).toBe(1)

    const outcomes = await runDueSchedules(JOBP())
    expect(outcomes.some((o) => o.schedule === s.id)).toBe(true)

    const log = await outboundLog(P)
    const sentToMe = log.rows.filter(
      (m) => m.related_type === 'report_schedule' && m.related === s.id,
    )
    expect(sentToMe.length).toBeGreaterThanOrEqual(1)

    await setSchedulePaused(P, { schedule: s.id, paused: true, reason: 'done for now zops' })
    mgr = await scheduleManager(P)
    expect(mgr.schedules.find((x) => x.id === s.id)!.active).toBe(false)
  })

  it('targets replace whole sets and the screen serves them', async () => {
    await replaceTargets(P, {
      subjectKind: 'staff',
      subject: fx.staff,
      targets: [
        { metric: 'billable_hours', amount: 100, periodKind: 'month', periodStart: '2026-08-01' },
      ],
    })
    const t = await targetsScreen(P)
    expect(
      t.targets.some(
        (x) => x.subject === fx.staff && x.metric === 'billable_hours' && Number(x.amount) === 100,
      ),
    ).toBe(true)
  })
})

describe('the import wizard reads', () => {
  it('validate-only and real runs land on the batch screens with per-record dispositions', async () => {
    const records = [
      { source_ref: 'z1', data: { kind: 'person', full_name: 'Zara Zops' } },
      { source_ref: 'z2', data: { kind: 'person', full_name: '' } },
    ]
    const v = await runImportBatch(
      P,
      { recordDomain: 'clients', sourceSystem: 'ZopsLegacy', records },
      { mode: 'validate_only' },
    )
    expect(v.state).toBe('completed')
    const list = await importScreens(P)
    expect(list.batches.some((b) => b.id === v.batch && b.mode === 'validate_only')).toBe(true)

    const r = await runImportBatch(
      P,
      { recordDomain: 'clients', sourceSystem: 'ZopsLegacy', records },
      { mode: 'real' },
    )
    const detail = await importBatchDetail(P, r.batch)
    expect(detail.records.map((x) => x.disposition)).toEqual(['accepted', 'refused'])
    expect(detail.records[0].target_type).toBe('party')
  })
})

describe('integration keys and search', () => {
  it('issue → list → detail → revoke, with the register trail on the detail', async () => {
    const k = await issueIntegrationKey(P, { label: 'Website zops', testMode: true })
    expect(k.secret.length).toBeGreaterThan(20)
    const list = await keysScreen(P)
    const mine = list.find((x) => x.id === k.id)
    expect(mine).toBeDefined()
    expect(mine!.test_mode).toBe(true)
    const detail = await keyDetail(P, k.id)
    expect(detail.activity.some((a) => a.event_kind === 'key.issued')).toBe(true)
    await revokeIntegrationKey(P, { key: k.id })
    const after = await keysScreen(P)
    expect(after.find((x) => x.id === k.id)!.revoked_at).not.toBeNull()
  })

  it('search finds the fixture client; own devices read serves empty shapes', async () => {
    const hits = await search(P, { query: 'zops' })
    expect(hits.hits.some((h) => h.entryType === 'party' && h.title.includes('Fixture Client zops'))).toBe(
      true,
    )
    const mine = await myDevicesAndSessions(P)
    expect(Array.isArray(mine.devices)).toBe(true)
    expect(Array.isArray(mine.sessions)).toBe(true)
    // the viewer's context read serves the schedulable flag + select lists
    const cat = await reportCatalogue(P)
    const ctx = await reportViewerContext(P, cat.definitions[0].key as string)
    expect(typeof ctx.schedulable).toBe('boolean')
    expect(ctx.staff.length).toBeGreaterThan(0)
  })
})
