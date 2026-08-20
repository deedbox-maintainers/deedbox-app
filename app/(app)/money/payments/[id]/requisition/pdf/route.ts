// The requisition as a downloadable PDF: the same facts the requisition
// screen shows, rendered through the bound HTML-to-PDF converter and handed
// to the browser as a file. Read-only; the operation's typed refusals
// surface here as plain text, and an unbound converter answers honestly.

import { requirePrincipal } from '@/lib/auth'
import { paymentRequisition } from '@/lib/reads/money'
import { requisitionDocumentHtml } from '@/lib/ops/outbound/presentation'
import { gotenbergConfigFromEnv, gotenbergHtmlToPdf } from '@/lib/bindings'
import { OperationRefused } from '@/lib/db'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const p = await requirePrincipal()
  const { id } = await params
  try {
    const data = await paymentRequisition(p, Number(id))
    const cfg = gotenbergConfigFromEnv()
    if (!cfg) {
      return new Response(
        'converter_not_configured: this deployment has no PDF converter bound — print the requisition page instead',
        { status: 503 },
      )
    }
    const pdf = await gotenbergHtmlToPdf(cfg)(requisitionDocumentHtml(data))
    const number = data.payment.payment_number
      ? String(data.payment.payment_number)
      : `requisition-${id}`
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${number}-requisition.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    if (e instanceof OperationRefused) {
      return new Response(`${e.code}: ${e.message}`, { status: 409 })
    }
    throw e
  }
}
