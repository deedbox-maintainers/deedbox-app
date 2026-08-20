'use server'

// Sign-in via the auth seam. The seam verifies the person;
// establishStaffSession resolves identity, applies the policy gates and
// creates the terminal session. The signed cookie then carries the session
// id; every request re-resolves it.

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { randomBytes } from 'node:crypto'
import { OperationRefused, theFirm, FirmMissing } from '@/lib/db'
import { establishStaffSession, recordCredentialFailure } from '@/lib/ops/security'
import {
  SESSION_COOKIE,
  DEVICE_COOKIE,
  sealSession,
  cookiesConfigured,
  signInService,
} from '@/lib/auth'
import { parse } from '@/components/forms'

function back(message: string): never {
  redirect(`/sign-in?refused=${encodeURIComponent(message)}`)
}

export async function signIn(formData: FormData): Promise<void> {
  const login = parse.str(formData, 'login')
  const secret = parse.str(formData, 'secret')
  if (!login) back('Enter your login.')
  if (!cookiesConfigured()) {
    back('Sign-in is not configured on this deployment (no cookie secret is set).')
  }

  const jar = await cookies()
  let fingerprint = jar.get(DEVICE_COOKIE)?.value
  if (!fingerprint || !/^[a-f0-9]{32}$/.test(fingerprint)) {
    fingerprint = randomBytes(16).toString('hex')
  }
  const h = await headers()
  const networkHint = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || undefined
  const label = (h.get('user-agent') ?? '').slice(0, 120) || undefined

  let firm: number
  try {
    firm = await theFirm()
  } catch (err) {
    // the two failures are different facts: only an EMPTY answer means the
    // instance is uninitialised; a connection failure is a moment's pressure
    // and says so honestly (staff were told "no firm exists" during
    // connection blips on the firm's first day live)
    if (err instanceof FirmMissing) back('This instance is not initialised — no firm exists yet.')
    back('The system is momentarily busy — your details were not checked. Please try again.')
  }

  let outcome
  try {
    const svc = signInService()
    const verdict = await svc.authenticate(login, secret)
    if (!verdict.authenticated) {
      await recordCredentialFailure(firm, login)
      back('Sign-in failed.')
    }
    outcome = await establishStaffSession({
      login,
      firm,
      mfaSatisfied: verdict.mfaSatisfied,
      device: { fingerprint, label, networkHint },
    })
  } catch (err) {
    if (err instanceof OperationRefused) {
      // refusal texts are honest but sparing on the public form
      if (err.code === 'sign_in_unbound') back(err.message)
      if (err.code === 'mfa_enrolment_required' || err.code === 'mfa_required') back(err.message)
      back('Sign-in failed.')
    }
    throw err
  }

  jar.set(DEVICE_COOKIE, fingerprint, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  })
  jar.set(SESSION_COOKIE, sealSession(outcome.session)!, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24,
  })
  redirect(outcome.stepUpRequired ? '/step-up' : '/')
}
