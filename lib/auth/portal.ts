// The portal shell's request resolution: its own cookie on the
// same HMAC carrier, resolved through the same terminal-session machinery
// — portal sessions re-evaluate idle and absolute windows on every request
// exactly like staff. Redirects stay inside the portal shell.

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { Principal } from '@/lib/db'
import { OperationRefused, theFirm, FirmMissing } from '@/lib/db'
import { resolveSessionPrincipal } from '@/lib/ops/security'
import { openSession } from './cookie'

export const PORTAL_COOKIE = 'deedbox_portal_session'

export async function resolvePortalRequest(): Promise<
  { principal: Principal } | { redirect: '/portal/sign-in' }
> {
  const jar = await cookies()
  const sessionId = openSession(jar.get(PORTAL_COOKIE)?.value)
  if (sessionId === null) return { redirect: '/portal/sign-in' }
  let firm: number
  try {
    firm = await theFirm()
  } catch (err) {
    // unreachable-database blips propagate to the error boundary; only a
    // genuinely uninitialised instance turns a viewer away to sign-in
    if (err instanceof FirmMissing) return { redirect: '/portal/sign-in' }
    throw err
  }
  try {
    const principal = await resolveSessionPrincipal(sessionId, firm)
    if (principal.kind !== 'portal_client') return { redirect: '/portal/sign-in' }
    return { principal }
  } catch (err) {
    if (err instanceof OperationRefused) return { redirect: '/portal/sign-in' }
    throw err
  }
}

export async function requirePortalPrincipal(): Promise<Principal> {
  const r = await resolvePortalRequest()
  if ('principal' in r) return r.principal
  redirect(r.redirect)
}
