// The public signing completion route: stamps, files, settles —
// one transaction inside completeSigning. The signer's address and browser
// join the request's permanent forensic record.

import { theFirm, OperationRefused } from '@/lib/db'
import { completeSigning } from '@/lib/ops/documents'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params
  const body = (await req.json().catch(() => ({}))) as { signature_data_url?: string }
  if (!body.signature_data_url) {
    return new Response('signature_data_url required', { status: 400 })
  }
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    null
  try {
    const r = await completeSigning(await theFirm(), token, {
      signatureDataUrl: body.signature_data_url,
      signerIp: ip,
      signerUserAgent: req.headers.get('user-agent'),
    })
    return Response.json({ signed_document: r.signedDocument })
  } catch (e) {
    if (e instanceof OperationRefused) return new Response(e.message, { status: 410 })
    throw e
  }
}
