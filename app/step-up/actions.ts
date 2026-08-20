'use server'

// Step-up: the seam verifies the challenge answer; completion marks the
// session usable and optionally trusts the device. Failure records
// signin.step_up_failed in its own transaction and the session stays
// unusable.

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { OperationRefused, theFirm } from '@/lib/db'
import { completeStepUp, recordStepUpFailure } from '@/lib/ops/security'
import { SESSION_COOKIE, openSession, signInService } from '@/lib/auth'
import { parse } from '@/components/forms'

export async function verifyStepUp(formData: FormData): Promise<void> {
  const jar = await cookies()
  const sessionId = openSession(jar.get(SESSION_COOKIE)?.value)
  if (sessionId === null) redirect('/sign-in')
  const firm = await theFirm()
  const answer = parse.str(formData, 'answer')
  const trustDevice = parse.bool(formData, 'trust_device')

  let passed = false
  try {
    const svc = signInService()
    passed = answer.length > 0 && (await svc.verifyStepUpChallenge(sessionId, answer))
  } catch (err) {
    if (err instanceof OperationRefused) {
      redirect(`/step-up?refused=${encodeURIComponent(err.message)}`)
    }
    throw err
  }
  if (!passed) {
    await recordStepUpFailure({ session: sessionId, firm })
    redirect(`/step-up?refused=${encodeURIComponent('That answer did not verify.')}`)
  }
  await completeStepUp({ session: sessionId, firm, trustDevice })
  redirect('/')
}

export async function abandonStepUp(): Promise<void> {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
  redirect('/sign-in')
}
