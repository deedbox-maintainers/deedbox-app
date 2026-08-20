'use server'

// Portal doors: accept an invitation, sign in, sign out. The
// hosted seam authenticates; the invite binding authorises; the portal
// cookie carries the terminal session id on the same HMAC carrier as
// staff, under its own name.

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { randomBytes } from 'node:crypto'
import { theFirm, OperationRefused } from '@/lib/db'
import { acceptPortalInvite, establishPortalSession, endPortalSession } from '@/lib/ops/portal'
import { PORTAL_COOKIE } from '@/lib/auth/portal'
import { DEVICE_COOKIE, sealSession, openSession, cookiesConfigured } from '@/lib/auth'

async function device(): Promise<{ fingerprint: string; label?: string }> {
  const jar = await cookies()
  let fingerprint = jar.get(DEVICE_COOKIE)?.value
  if (!fingerprint || !/^[a-f0-9]{32}$/.test(fingerprint)) {
    fingerprint = randomBytes(16).toString('hex')
  }
  const h = await headers()
  return { fingerprint, label: (h.get('user-agent') ?? '').slice(0, 120) || undefined }
}

async function setPortalCookies(sessionId: number, fingerprint: string): Promise<void> {
  const jar = await cookies()
  const sealed = sealSession(sessionId)
  if (sealed === null) redirect('/portal/sign-in?refused=cookies_unconfigured')
  const opts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  }
  jar.set(PORTAL_COOKIE, sealed, opts)
  jar.set(DEVICE_COOKIE, fingerprint, { ...opts, maxAge: 60 * 60 * 24 * 365 })
}

export async function portalAcceptAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '')
  const login = String(formData.get('login') ?? '').trim()
  const secret = String(formData.get('secret') ?? '')
  if (!cookiesConfigured()) redirect(`/portal/accept/${encodeURIComponent(token)}?refused=cookies_unconfigured`)
  const d = await device()
  let session: number
  try {
    const r = await acceptPortalInvite(await theFirm(), token, { login, secret, device: d })
    session = r.session
  } catch (e) {
    const msg = e instanceof OperationRefused ? e.message : 'that did not work'
    redirect(`/portal/accept/${encodeURIComponent(token)}?refused=${encodeURIComponent(msg)}`)
  }
  await setPortalCookies(session, d.fingerprint)
  redirect('/portal')
}

export async function portalSignInAction(formData: FormData): Promise<void> {
  const login = String(formData.get('login') ?? '').trim()
  const secret = String(formData.get('secret') ?? '')
  if (!cookiesConfigured()) redirect('/portal/sign-in?refused=cookies_unconfigured')
  const d = await device()
  let session: number
  try {
    const r = await establishPortalSession(await theFirm(), { login, secret, device: d })
    session = r.session
  } catch (e) {
    const msg = e instanceof OperationRefused ? e.message : 'that did not work'
    redirect(`/portal/sign-in?refused=${encodeURIComponent(msg)}`)
  }
  await setPortalCookies(session, d.fingerprint)
  redirect('/portal')
}

export async function portalSignOutAction(): Promise<void> {
  const jar = await cookies()
  const sessionId = openSession(jar.get(PORTAL_COOKIE)?.value)
  if (sessionId !== null) {
    await endPortalSession(await theFirm(), sessionId)
  }
  jar.delete(PORTAL_COOKIE)
  redirect('/portal/sign-in')
}
