// Portal invitation acceptance: the invited person proves the
// hosted identity they will use; the binding is written exactly once and
// their first session opens.

import { portalAcceptAction } from '../../actions'

export const dynamic = 'force-dynamic'

export default async function PortalAcceptPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { token } = await params
  const sp = await searchParams
  const refused = typeof sp.refused === 'string' ? sp.refused : null
  return (
    <main style={{ maxWidth: 460, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.3rem' }}>Accept your portal invitation</h1>
      <p>
        Sign in with the account you will use for the portal. The invitation binds it to your
        client record; this is done once.
      </p>
      {refused && <p style={{ color: '#b91c1c' }}>{refused}</p>}
      <form action={portalAcceptAction}>
        <input type="hidden" name="token" value={token} />
        <p>
          <label>
            Email
            <br />
            <input type="email" name="login" required style={{ border: '1px solid #ccc', padding: '0.35rem', width: '100%' }} />
          </label>
        </p>
        <p>
          <label>
            Password
            <br />
            <input type="password" name="secret" required style={{ border: '1px solid #ccc', padding: '0.35rem', width: '100%' }} />
          </label>
        </p>
        <button type="submit" style={{ padding: '0.45rem 1.2rem', border: '1px solid #333', cursor: 'pointer', fontWeight: 600 }}>
          Accept and sign in
        </button>
      </form>
    </main>
  )
}
