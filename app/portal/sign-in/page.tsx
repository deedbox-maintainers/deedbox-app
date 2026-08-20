// Portal sign-in: the hosted seam authenticates; the accepted
// invitation authorises; the session rides the shared terminal machinery.

import { portalSignInAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function PortalSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const refused = typeof sp.refused === 'string' ? sp.refused : null
  return (
    <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.3rem' }}>Client portal</h1>
      {refused && <p style={{ color: '#b91c1c' }}>{refused}</p>}
      <form action={portalSignInAction}>
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
          Sign in
        </button>
      </form>
      <p style={{ color: '#666', fontSize: '0.85rem' }}>
        First time here? Use the invitation link your firm sent you.
      </p>
    </main>
  )
}
