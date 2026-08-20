// The public share serve route: resolves the token (spending
// one view + recording access evidence inside that transaction), fetches
// the pinned version's bytes, watermarks PDFs when the share demands it,
// and streams with the disposition the share allows. Never indexed.

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { theFirm, OperationRefused } from '@/lib/db'
import { resolveShareForServe, requireByteFetch } from '@/lib/ops/documents'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params
  const url = new URL(req.url)
  const password = url.searchParams.get('p')

  let resolved
  try {
    resolved = await resolveShareForServe(await theFirm(), token, password)
  } catch (e) {
    if (e instanceof OperationRefused) {
      if (e.code === 'password_wrong' || e.code === 'password_required') {
        return Response.redirect(
          new URL(`/share/${encodeURIComponent(token)}?e=password_wrong`, url.origin),
          303,
        )
      }
      return new Response(e.message, { status: 410, headers: { 'X-Robots-Tag': 'noindex, nofollow' } })
    }
    throw e
  }

  const fetched = await requireByteFetch()(resolved.storageRef)
  let bytes: Buffer = fetched.bytes
  const isPdf =
    resolved.contentType.toLowerCase().includes('pdf') ||
    resolved.filename.toLowerCase().endsWith('.pdf')
  if (resolved.watermark && isPdf) {
    try {
      const pdf = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true })
      const font = await pdf.embedFont(StandardFonts.HelveticaBold)
      const stamp = `CONFIDENTIAL — ${new Date().toISOString().slice(0, 10)}`
      for (const page of pdf.getPages()) {
        const { width, height } = page.getSize()
        page.drawText(stamp, {
          x: width * 0.15,
          y: height * 0.5,
          size: 36,
          font,
          color: rgb(0.85, 0.1, 0.1),
          opacity: 0.18,
          rotate: degrees(-30),
        })
      }
      bytes = Buffer.from(await pdf.save())
    } catch {
      // an unstampable file serves as it is — the flag is best-effort presentation
    }
  }

  const disposition = resolved.allowDownload ? 'attachment' : 'inline'
  const safe = resolved.filename.replace(/["\r\n]/g, '_')
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': resolved.contentType,
      'Content-Disposition': `${disposition}; filename="${safe}"`,
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}
