// 0047 — a matter is findable by the people and numbers a firm knows it by.
//
// A migrated matter often carries a bare file reference as its title, so a
// search entry holding only number + title + summary cannot find it by the
// client's name — and the prior-system reference, though displayed, was not
// searchable either.
//
// These tests pin the rule: a client's name finds their matter; the
// prior-system reference finds the matter; a client rename re-indexes
// every matter that names them.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool, type Principal } from '@/lib/db'
import { search } from '@/lib/ops/reports'
import { matterList } from '@/lib/reads/matters'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal

const TAG = 'xsrc'

describe('search knows what a firm calls its files', () => {
  beforeAll(async () => {
    admin = makeAdminPool()
    fx = await buildFixture(admin, TAG)
    P = { kind: 'staff', id: fx.staff, firm: fx.firm }
    // the shape that caused the support question: a title with no client
    // name in it, and a prior-system number from a migration
    await admin.query(
      `insert into deedbox.party (kind, display_name) values ('person', 'Priya Naganathan xsrc')`,
    )
    const p = await admin.query(
      `select id from deedbox.party where display_name = 'Priya Naganathan xsrc'`,
    )
    await admin.query(
      `insert into deedbox.party_name (party, name_kind, full_name)
       values ($1, 'current', 'Priya Naganathan xsrc')`,
      [p.rows[0].id],
    )
    await admin.query(
      `insert into deedbox.matter
         (matter_number, title, client_party, responsible_lawyer, office, practice_area, prior_reference)
       select 'T-xsrc-000777', 'QX300900 - Family Law', $1, m.responsible_lawyer, m.office, m.practice_area, '20431'
         from deedbox.matter m where m.id = $2`,
      [p.rows[0].id, fx.matter],
    )
  })

  afterAll(async () => {
    await closePool()
    await admin.end()
  })

  it("the client's name finds the matter, even when the title never mentions them", async () => {
    const r = await search(P, { query: 'Priya Naganathan', entryType: 'matter' })
    expect(r.hits.some((h) => h.title.includes('QX300900'))).toBe(true)
  })

  it('the prior-system number finds the matter', async () => {
    const r = await search(P, { query: '20431', entryType: 'matter' })
    expect(r.hits.some((h) => h.title.includes('QX300900'))).toBe(true)
  })

  it('the matters screen filter matches client name and prior number too', async () => {
    const byName = await matterList(P, { q: 'Priya Naganathan' } as any)
    expect(byName.some((m: any) => m.title === 'QX300900 - Family Law')).toBe(true)
    const byPrior = await matterList(P, { q: '20431' } as any)
    expect(byPrior.some((m: any) => m.title === 'QX300900 - Family Law')).toBe(true)
  })

  it('renaming the client re-indexes their matters', async () => {
    const p = await admin.query(
      `select id from deedbox.party where display_name = 'Priya Naganathan xsrc'`,
    )
    await admin.query(
      `update deedbox.party set display_name = 'Priya Sharma xsrc' where id = $1`,
      [p.rows[0].id],
    )
    const r = await search(P, { query: 'Priya Sharma', entryType: 'matter' })
    expect(r.hits.some((h) => h.title.includes('QX300900'))).toBe(true)
  })
})
