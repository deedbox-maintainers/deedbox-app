// Portal matter view: the matter's basics and its issued bills
// with outstanding figures — served under the portal predicate; an
// invisible matter is simply not found.

import Link from 'next/link'
import { requirePortalPrincipal } from '@/lib/auth/portal'
import { portalMatter } from '@/lib/reads/portal'
import { formatMoney, type Regional } from '@/lib/format'

export const dynamic = 'force-dynamic'

// The firm's own currency — resolved with the matter read.
function money(n: number, regional: Regional): string {
  return formatMoney(n, regional)
}

export default async function PortalMatterPage({ params }: { params: Promise<{ id: string }> }) {
  const p = await requirePortalPrincipal()
  const { id } = await params
  let data
  try {
    data = await portalMatter(p, Number(id))
  } catch {
    return (
      <main style={{ maxWidth: 640, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
        <p>That matter is not available.</p>
        <Link href="/portal">Back</Link>
      </main>
    )
  }
  return (
    <main style={{ maxWidth: 640, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <p>
        <Link href="/portal" style={{ color: '#2563eb', textDecoration: 'none' }}>
          ← Your matters
        </Link>
      </p>
      <h1 style={{ fontSize: '1.3rem' }}>
        {data.matter.matterNumber} — {data.matter.title}
      </h1>
      <p style={{ color: '#666' }}>
        Standing: {data.matter.status.replace(/_/g, ' ')} · Your lawyer: {data.responsible}
      </p>
      <h2 style={{ fontSize: '1.05rem', marginTop: '1.5rem' }}>Bills</h2>
      {data.bills.length === 0 ? (
        <p>No bills have been issued on this matter.</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              {['Bill', 'Issued', 'Total', 'Outstanding'].map((h) => (
                <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '0.4rem 0.5rem' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.bills.map((b) => (
              <tr key={b.id}>
                <td style={{ padding: '0.4rem 0.5rem' }}>{b.billNumber}</td>
                <td style={{ padding: '0.4rem 0.5rem' }}>{b.issueDate.slice(0, 10)}</td>
                <td style={{ padding: '0.4rem 0.5rem' }}>{money(b.total, data.regional)}</td>
                <td style={{ padding: '0.4rem 0.5rem' }}>{money(b.outstanding, data.regional)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
