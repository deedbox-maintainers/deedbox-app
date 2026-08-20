// The public share page: resolves the link's metadata without
// spending a view; the View/Download buttons hit the serve route, which
// spends one view inside its own transaction. Typed refusals render as
// honest plain-language notices.

import { theFirm, OperationRefused } from '@/lib/db'
import { peekShare } from '@/lib/ops/documents'

export const dynamic = 'force-dynamic'

export default async function SharePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { token } = await params
  const sp = await searchParams
  const wrongPassword = sp.e === 'password_wrong'

  let meta: { title: string; filename: string; passwordRequired: boolean } | null = null
  let notice: string | null = null
  try {
    meta = await peekShare(await theFirm(), token)
  } catch (e) {
    notice = e instanceof OperationRefused ? e.message : 'this link is not available'
  }

  return (
    <main style={{ maxWidth: 560, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.3rem' }}>Shared document</h1>
      {notice && <p>{notice}</p>}
      {meta && (
        <>
          <p>
            <strong>{meta.title}</strong>
            <br />
            {meta.filename}
          </p>
          {wrongPassword && <p style={{ color: '#b91c1c' }}>That password is not right.</p>}
          <form action={`/api/share/${encodeURIComponent(token)}`} method="get">
            {meta.passwordRequired && (
              <p>
                <label>
                  Password{' '}
                  <input type="password" name="p" required style={{ border: '1px solid #ccc', padding: '0.3rem' }} />
                </label>
              </p>
            )}
            <button type="submit" style={{ padding: '0.4rem 1rem', border: '1px solid #333', cursor: 'pointer' }}>
              Open the document
            </button>
          </form>
          <p style={{ color: '#666', fontSize: '0.85rem' }}>
            Each open counts against the link&apos;s view limit where one is set.
          </p>
        </>
      )}
    </main>
  )
}
