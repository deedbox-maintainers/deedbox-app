'use server'

// Examiner sign-in. Unlike staff, the examiner credential is the platform's
// own — issued shown-once when the examiner grant is created, hashed at
// rest — so this path never touches the hosted auth seam: examinerSignIn
// verifies the secret against the grant, checks the access window, and
// creates the terminal session. The signed cookie then carries the session
// id exactly as for staff; every request re-resolves it and re-checks the
// grant window.

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { randomBytes } from 'node:crypto'
import { OperationRefused, theFirm, FirmMissing } from '@/lib/db'
import { examinerSignIn } from '@/lib/ops/security'
import { SESSION_COOKIE, DEVICE_COOKIE, sealSession, cookiesConfigured } from '@/lib/auth'
import { parse } from '@/components/forms'

function back(message: string): never {
  redirect(`/examiner/sign-in?refused=${encodeURIComponent(message)}`)
}

export async function signInExaminer(formData: FormData): Promise<void> {
  const login = parse.str(formData, 'login')
  const secret = parse.str(formData, 'secret')
  if (!login || !secret) back('Enter your login and access secret.')
  if (!cookiesConfigured()) {
    back('Sign-in is not configured on this deployment (no cookie secret is set).')
  }

  const jar = await cookies()
  let fingerprint = jar.get(DEVICE_COOKIE)?.value
  if (!fingerprint || !/^[a-f0-9]{32}$/.test(fingerprint)) {
    fingerprint = randomBytes(16).toString('hex')
  }
  const h = await headers()
  const label = (h.get('user-agent') ?? '').slice(0, 120) || undefined

  let firm: number
  try {
    firm = await theFirm()
  } catch (err) {
    if (err instanceof FirmMissing) back('This instance is not initialised — no firm exists yet.')
    back('The system is momentarily busy — your details were not checked. Please try again.')
  }

  let outcome
  try {
    outcome = await examinerSignIn({
      login,
      secret,
      firm,
      device: { fingerprint, label },
    })
  } catch (err) {
    if (err instanceof OperationRefused) {
      back('Sign-in failed — check your login, secret and access window.')
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
  redirect('/examiner')
}
