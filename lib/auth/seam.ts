// The sign-in service seam. The hosted platform's auth service
// AUTHENTICATES people; this layer resolves the authenticated identity to
// a staff row and authorises. Until the real service is bound, the seam
// refuses typed — the same posture as the outbound delivery transport —
// EXCEPT under the explicit development binding
// (DEEDBOX_DEV_SIGNIN=allow), which accepts any non-empty secret and
// satisfies every challenge. That binding exists so the screens can be
// driven locally; it is loudly not authentication.

import { OperationRefused } from '@/lib/db'
import { seamSlot } from '@/lib/seam-slot'

export interface SignInService {
  /** Verify the person's credentials; the seam owns HOW. */
  authenticate(login: string, secret: string): Promise<{ authenticated: boolean; mfaSatisfied: boolean }>
  /** Verify a step-up challenge answer for the session's person. */
  verifyStepUpChallenge(sessionId: number, answer: string): Promise<boolean>
}

// Process-wide, not module-level: see lib/seam-slot.ts for why.
const slot = seamSlot<SignInService>('sign-in-service')

/** The deployment binds the hosted service here. */
export function setSignInService(svc: SignInService | null): void {
  slot.set(svc)
}

const devService: SignInService = {
  async authenticate(_login, secret) {
    return { authenticated: secret.length > 0, mfaSatisfied: true }
  },
  async verifyStepUpChallenge(_sessionId, answer) {
    return answer.length > 0
  },
}

export function signInService(): SignInService {
  const bound = slot.get()
  if (bound) return bound
  if (process.env.DEEDBOX_DEV_SIGNIN === 'allow') return devService
  throw new OperationRefused(
    'sign_in_unbound',
    'no sign-in service is bound — the hosted authentication seam is not configured',
  )
}
