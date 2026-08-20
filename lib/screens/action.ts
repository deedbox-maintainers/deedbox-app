// The one server-action wrapper. A screen action is: resolve the principal,
// parse the form, call the named operation, and come back with an honest
// notice — a typed refusal shows as the operation's own words, and anything
// unclassified rethrows (the error boundary shows it; nothing is swallowed).
//
// The redirect happens OUTSIDE the try so Next's control-flow throw is
// never caught here.

import { redirect } from 'next/navigation'
import type { Principal } from '@/lib/db'
import { OperationRefused, MoneyRefusal, MoneyPreconditionFailed } from '@/lib/db'
import { requirePrincipal } from '@/lib/auth'
import { FormValueError } from '@/components/forms'

function withNotice(path: string, key: 'done' | 'refused', message: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}${key}=${encodeURIComponent(message)}`
}

/**
 * Run an operation for a form submission and land back on `returnTo` with
 * the outcome in the query string. The body may return a success message,
 * or a path to land on instead (prefixed 'goto:').
 */
export async function act(
  returnTo: string,
  fn: (p: Principal) => Promise<string | void>,
): Promise<never> {
  const p = await requirePrincipal()
  let dest: string
  try {
    const outcome = await fn(p)
    dest =
      typeof outcome === 'string' && outcome.startsWith('goto:')
        ? outcome.slice(5)
        : withNotice(returnTo, 'done', typeof outcome === 'string' ? outcome : 'Done.')
  } catch (err) {
    if (err instanceof OperationRefused) {
      dest = withNotice(returnTo, 'refused', err.message)
    } else if (err instanceof MoneyRefusal) {
      dest = withNotice(returnTo, 'refused', `Refused and recorded: ${err.reason} (refusal #${err.refusalId})`)
    } else if (err instanceof MoneyPreconditionFailed) {
      dest = withNotice(returnTo, 'refused', err.message)
    } else if (err instanceof FormValueError) {
      // a field the form could not read as what the operation needs — the
      // person sees which one, and nothing reached the database
      dest = withNotice(returnTo, 'refused', `Check the form: ${err.message}.`)
    } else {
      throw err
    }
  }
  redirect(dest)
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>

/** Normalise Next's searchParams for the Notices component and filters. */
export async function readParams(
  sp: SearchParams,
): Promise<Record<string, string>> {
  const raw = await sp
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v
    else if (Array.isArray(v) && v.length > 0) out[k] = v[0]
  }
  return out
}
