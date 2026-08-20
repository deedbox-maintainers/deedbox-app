// The sign-in service binding: the hosted platform's auth service behind the lib/auth seam — the
// hosted service AUTHENTICATES; the session layer resolves identity and authorises. The service
// speaks the hosted platform's token protocol: one POST with the login and secret; 200 means the
// person is who they claim.
//
// Second factor, honestly: the token grant reports the account's enrolled factors. A bare password
// grant satisfies no enrolled factor, so mfaSatisfied is true only when the account has none — a
// firm whose policy demands a second factor refuses typed at sign-in until factor verification
// arrives with the enrolment surfaces (recorded, deliberate).
//
// Step-up: with a delegated sign-in service, the challenge is PROVIDER RE-AUTHENTICATION — the
// person re-enters their password and the service re-verifies it, maximally fresh. The binding
// resolves the session to its staff login and replays the same token grant.

import type { SignInService } from '@/lib/auth/seam'
import type { Principal } from '@/lib/db'
import { withPrincipal, theFirm, OperationRefused } from '@/lib/db'
import type { HttpPost } from './email'

const realPost: HttpPost = async (url, headers, body) => {
  const r = await fetch(url, { method: 'POST', headers, body })
  return { status: r.status, text: await r.text().catch(() => '') }
}

export interface HostedSignInConfig {
  /** The hosted platform's base URL (the token endpoint lives under /auth/v1). */
  url: string
  /** The platform's publishable key, sent as the apikey header. */
  apiKey: string
  /**
   * The firm whose sessions this service answers for. Production leaves it
   * unset (the one firm resolves); the suite's shared scratch hosts many
   * firms, so tests pass theirs.
   */
  firm?: number
  post?: HttpPost
}

interface GrantOutcome {
  ok: boolean
  hasVerifiedFactor: boolean
}

async function passwordGrant(
  cfg: HostedSignInConfig,
  post: HttpPost,
  login: string,
  secret: string,
): Promise<GrantOutcome> {
  const base = cfg.url.replace(/\/+$/, '')
  const r = await post(
    `${base}/auth/v1/token?grant_type=password`,
    { apikey: cfg.apiKey, 'Content-Type': 'application/json' },
    JSON.stringify({ email: login, password: secret }),
  )
  if (r.status >= 200 && r.status < 300) {
    let hasVerifiedFactor = false
    try {
      const parsed = JSON.parse(r.text) as {
        user?: { factors?: { status?: string }[] }
      }
      hasVerifiedFactor = (parsed.user?.factors ?? []).some((f) => f.status === 'verified')
    } catch {
      // an unparsable success body still authenticated the person
    }
    return { ok: true, hasVerifiedFactor }
  }
  if (r.status >= 400 && r.status < 500) {
    return { ok: false, hasVerifiedFactor: false }
  }
  throw new OperationRefused(
    'sign_in_unavailable',
    `the sign-in service could not be reached (HTTP ${r.status})`,
  )
}

export function hostedSignInService(cfg: HostedSignInConfig): SignInService {
  const post = cfg.post ?? realPost
  return {
    async authenticate(login, secret) {
      if (!login.trim() || !secret) return { authenticated: false, mfaSatisfied: false }
      const grant = await passwordGrant(cfg, post, login.trim(), secret)
      if (!grant.ok) return { authenticated: false, mfaSatisfied: false }
      // a bare password grant satisfies no enrolled factor
      return { authenticated: true, mfaSatisfied: !grant.hasVerifiedFactor }
    },

    async verifyStepUpChallenge(sessionId, answer) {
      if (!answer) return false
      const firm = cfg.firm ?? (await theFirm())
      // the same read context the sign-in machinery itself uses (system id 0)
      const system: Principal = { kind: 'system_job', id: 0, firm }
      const login = await withPrincipal(
        system,
        async (tx) => {
          const r = await tx.query(
            `select st.login
               from deedbox.session s
               join deedbox.staff_member st on st.id = s.principal
              where s.id = $1 and s.principal_kind = 'staff' and s.ended_at is null`,
            [sessionId],
          )
          return r.rowCount === 0 ? null : (r.rows[0].login as string)
        },
        { readOnly: true },
      )
      if (login === null) return false
      const grant = await passwordGrant(cfg, post, login, answer)
      return grant.ok
    },
  }
}
