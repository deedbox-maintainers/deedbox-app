// The public signing page: shows what is being signed and by
// whom, and captures the signature. The completion route stamps the PDF,
// files the signed copy, and settles the request in one transaction.

import { theFirm, OperationRefused } from '@/lib/db'
import { peekSigningRequest } from '@/lib/ops/documents'
import SignPad from './sign-pad'

export const dynamic = 'force-dynamic'

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  let meta: { title: string; filename: string; signerName: string } | null = null
  let notice: string | null = null
  try {
    meta = await peekSigningRequest(await theFirm(), token)
  } catch (e) {
    notice = e instanceof OperationRefused ? e.message : 'this link is not available'
  }

  return (
    <main style={{ maxWidth: 560, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.3rem' }}>Signature requested</h1>
      {notice && <p>{notice}</p>}
      {meta && (
        <>
          <p>
            <strong>{meta.title}</strong>
            <br />
            {meta.filename}
            <br />
            To be signed by <strong>{meta.signerName}</strong>. The signed copy carries your
            signature, the time, and the address it was signed from.
          </p>
          <SignPad token={token} signerName={meta.signerName} />
        </>
      )}
    </main>
  )
}
