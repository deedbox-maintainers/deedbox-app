// The client portal (schema change 0034): the invite lifecycle
// (shown-once token, wrong-secret refusal, exactly-once acceptance,
// returning sign-ins, expiry), the session resolver serving the TRUE
// portal kind (the two-way staff/examiner mapping was a latent defect
// this slice fixed), the 0005 predicate proven END-TO-END through the
// portal reads (the toggled matter visible, the untoggled one not), and
// revocation ending live sessions in the same transaction.
//
// Cross-suite contract: binds its OWN fake sign-in service and unbinds in
// afterAll. Flips no settings. Fixture tag 'ptl' (first-three unique).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { setSignInService } from '@/lib/auth/seam'
import {
  createPortalInvite,
  revokePortalInvite,
  acceptPortalInvite,
  establishPortalSession,
  endPortalSession,
} from '@/lib/ops/portal'
import { resolveSessionPrincipal } from '@/lib/ops/security'
import { portalHome, portalMatter } from '@/lib/reads/portal'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let hiddenMatter = 0

const DEVICE = { fingerprint: 'a'.repeat(32), label: 'ptl-suite' }

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'ptl')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  setSignInService({
    async authenticate(_login, secret) {
      return { authenticated: secret === 'good', mfaSatisfied: true }
    },
    async verifyStepUpChallenge() {
      return true
    },
  })
  // the fixture matter is shared with the client; a second matter is not
  await admin.query(
    `update deedbox.matter_party set portal_access = true
      where matter = $1 and party = $2`,
    [fx.matter, fx.clientParty],
  )
  const num = await admin.query(`select deedbox.allocate_number('matter', null, current_date) as n`)
  const m2 = await admin.query(
    `insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
     values ($1, 'PTL hidden matter', $2, $3, $4, $5) returning id`,
    [num.rows[0].n, fx.clientParty, fx.staff, fx.office, fx.practiceArea],
  )
  hiddenMatter = m2.rows[0].id as number
})

afterAll(async () => {
  setSignInService(null)
  await closePool()
  await admin.end()
})

describe('the client portal', () => {
  let token = ''
  let session = 0

  it('the invite lifecycle: shown once, wrong secrets refused, acceptance exactly once', async () => {
    const inv = await createPortalInvite(P, {
      party: fx.clientParty,
      email: 'ptl.client@example.test',
    })
    token = inv.token
    expect(token.startsWith('pin_')).toBe(true)
    const reg = await admin.query(
      `select detail::text as d from deedbox.register_entry
        where event_kind = 'record.created' and subject_type = 'portal_invite' and subject = $1`,
      [inv.invite],
    )
    expect(reg.rowCount).toBe(1)
    expect((reg.rows[0].d as string).includes(token)).toBe(false)

    await expect(
      acceptPortalInvite(fx.firm, token, { login: 'client@hosted.test', secret: 'bad', device: DEVICE }),
    ).rejects.toMatchObject({ code: 'sign_in_failed' })

    const accepted = await acceptPortalInvite(fx.firm, token, {
      login: 'client@hosted.test',
      secret: 'good',
      device: DEVICE,
    })
    expect(accepted.party).toBe(fx.clientParty)
    session = accepted.session

    await expect(
      acceptPortalInvite(fx.firm, token, { login: 'other@hosted.test', secret: 'good', device: DEVICE }),
    ).rejects.toMatchObject({ code: 'already_accepted' })
  })

  it('the session resolves as the TRUE portal kind (the fixed mapping)', async () => {
    const principal = await resolveSessionPrincipal(session, fx.firm)
    expect(principal.kind).toBe('portal_client')
    expect(principal.id).toBe(fx.clientParty)
  })

  it('the predicate end-to-end: the toggled matter visible, the untoggled one not', async () => {
    const portal: Principal = { kind: 'portal_client', id: fx.clientParty, firm: fx.firm, session }
    const home = await portalHome(portal)
    expect(home.matters.some((m) => m.id === fx.matter)).toBe(true)
    expect(home.matters.some((m) => m.id === hiddenMatter)).toBe(false)

    const visible = await portalMatter(portal, fx.matter)
    expect(visible.matter.id).toBe(fx.matter)
    expect(Array.isArray(visible.bills)).toBe(true)

    await expect(portalMatter(portal, hiddenMatter)).rejects.toThrow('not_found')
  })

  it('returning sign-ins ride the binding; unknown identities are refused', async () => {
    const back = await establishPortalSession(fx.firm, {
      login: 'client@hosted.test',
      secret: 'good',
      device: DEVICE,
    })
    expect(back.party).toBe(fx.clientParty)
    await endPortalSession(fx.firm, back.session)

    await expect(
      establishPortalSession(fx.firm, { login: 'stranger@hosted.test', secret: 'good', device: DEVICE }),
    ).rejects.toMatchObject({ code: 'no_portal_access' })
  })

  it('revocation ends live sessions in the same transaction', async () => {
    const inv = await admin.query(
      `select id from deedbox.portal_invite where party = $1 and revoked_at is null order by id limit 1`,
      [fx.clientParty],
    )
    await revokePortalInvite(P, { invite: inv.rows[0].id as number })
    await expect(resolveSessionPrincipal(session, fx.firm)).rejects.toMatchObject({
      code: 'session_ended',
    })
    await expect(
      establishPortalSession(fx.firm, { login: 'client@hosted.test', secret: 'good', device: DEVICE }),
    ).rejects.toMatchObject({ code: 'no_portal_access' })
  })

  it('an expired invitation refuses acceptance typed', async () => {
    const fresh = await createPortalInvite(P, {
      party: fx.clientParty,
      email: 'ptl.late@example.test',
    })
    await admin.query(
      `update deedbox.portal_invite set expires_at = now() - interval '1 hour' where id = $1`,
      [fresh.invite],
    )
    await expect(
      acceptPortalInvite(fx.firm, fresh.token, { login: 'late@hosted.test', secret: 'good', device: DEVICE }),
    ).rejects.toMatchObject({ code: 'share_expired' })
  })
})
