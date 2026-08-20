// The request layer's principal resolution: read the signed session
// cookie, resolve the terminal session row per request — idle and
// absolute windows, the step-up gate, the staff active flag are all
// evaluated by resolveSessionPrincipal on every call; nothing about
// authority is cached anywhere. Server components use requirePrincipal
// (redirecting), server actions use it too; route handlers use
// resolveRequest and answer JSON.

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { Principal } from '@/lib/db'
import { OperationRefused, theFirm, withPrincipal, FirmMissing } from '@/lib/db'
import { resolveSessionPrincipal, endSession, endExaminerSession } from '@/lib/ops/security'
import { SESSION_COOKIE, openSession } from './cookie'

export type Resolution =
  | { principal: Principal }
  | { redirect: '/sign-in' | '/step-up' }

export async function resolveRequest(): Promise<Resolution> {
  const jar = await cookies()
  const sessionId = openSession(jar.get(SESSION_COOKIE)?.value)
  if (sessionId === null) return { redirect: '/sign-in' }
  let firm: number
  try {
    firm = await theFirm()
  } catch (err) {
    // an uninitialised instance signs nobody in; a momentarily unreachable
    // database is NOT a sign-out — it propagates to the error boundary and
    // the person's session survives the retry (the old catch-all here
    // bounced working staff to sign-in on connection blips)
    if (err instanceof FirmMissing) return { redirect: '/sign-in' }
    throw err
  }
  try {
    const principal = await resolveSessionPrincipal(sessionId, firm)
    return { principal }
  } catch (err) {
    if (err instanceof OperationRefused) {
      if (err.code === 'step_up_required') return { redirect: '/step-up' }
      return { redirect: '/sign-in' }
    }
    throw err
  }
}

/** For pages and layouts: the principal, or a redirect out of the shell. */
export async function requirePrincipal(): Promise<Principal> {
  const r = await resolveRequest()
  if ('principal' in r) return r.principal
  redirect(r.redirect)
}

/**
 * The viewer's capability keys (their role's grant rows), resolved fresh
 * for navigation and per-screen affordances. Display-only convenience —
 * every operation and read re-checks for itself.
 */
export async function viewerContext(p: Principal): Promise<{
  name: string
  capabilities: Set<string>
}> {
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select s.person_name, rc.capability
           from deedbox.staff_member s
           left join deedbox.role_capability rc on rc.role = s.role and rc.scope <> 'none'
          where s.id = $1`,
        [p.id],
      )
      const caps = new Set<string>()
      for (const row of r.rows) if (row.capability) caps.add(row.capability as string)
      const person = r.rows[0]?.person_name as { display?: string; given?: string; family?: string } | undefined
      const name =
        person?.display ?? [person?.given, person?.family].filter(Boolean).join(' ') ?? 'Signed in'
      return { name: name || 'Signed in', capabilities: caps }
    },
    { readOnly: true },
  )
}

/**
 * End the cookie's session (sign-out), tolerating an unusable-until-step-up
 * session: the session's own staff member is the acting principal for the
 * logout, which is what makes an own-logout always possible.
 */
export async function signOutCookieSession(): Promise<void> {
  const jar = await cookies()
  const sessionId = openSession(jar.get(SESSION_COOKIE)?.value)
  if (sessionId === null) return
  const firm = await theFirm()
  const row = await withPrincipal(
    { kind: 'system_job', id: 0, firm },
    async (tx) => {
      const s = await tx.query(
        `select principal_kind, principal, ended_at from deedbox.session where id = $1`,
        [sessionId],
      )
      return s.rows[0] as { principal_kind: string; principal: number; ended_at: unknown } | undefined
    },
    { readOnly: true },
  )
  if (!row || row.ended_at !== null) return
  if (row.principal_kind === 'examiner') {
    await endExaminerSession(sessionId, firm)
    return
  }
  if (row.principal_kind !== 'staff') return
  await endSession(
    { kind: 'staff', id: row.principal, firm, session: sessionId },
    { session: sessionId },
  )
}
