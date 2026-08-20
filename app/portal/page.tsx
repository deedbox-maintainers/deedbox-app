// Portal home: the matters this client may see — the 0005
// predicate's portal rule does the scoping, nothing bespoke.

import Link from 'next/link'
import { requirePortalPrincipal } from '@/lib/auth/portal'
import { portalHome } from '@/lib/reads/portal'
import { portalSignOutAction } from './actions'

export const dynamic = 'force-dynamic'

export default async function PortalHomePage() {
  const p = await requirePortalPrincipal()
  const home = await portalHome(p)
  return (
    <main style={{ maxWidth: 640, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ fontSize: '1.3rem' }}>Your matters</h1>
        <form action={portalSignOutAction}>
          <button type="submit" style={{ border: 'none', background: 'none', color: '#2563eb', cursor: 'pointer' }}>
            Sign out
          </button>
        </form>
      </div>
      <p>Welcome, {home.partyName}.</p>
      {home.matters.length === 0 ? (
        <p>No matters are shared with you at the moment.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {home.matters.map((m) => (
            <li key={m.id} style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.7rem 1rem', marginBottom: '0.6rem' }}>
              <Link href={`/portal/matters/${m.id}`} style={{ color: '#2563eb', textDecoration: 'none', fontWeight: 600 }}>
                {m.matterNumber} — {m.title}
              </Link>
              <span style={{ color: '#666', marginLeft: '0.6rem' }}>{m.status.replace(/_/g, ' ')}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
