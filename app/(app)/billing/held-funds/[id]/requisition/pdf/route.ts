// The run's consolidated EFT requisition as a downloadable PDF: every
// completed transfer on one form with one total, rendered through the bound
// HTML-to-PDF converter. Read-only; typed refusals surface as plain text,
// and an unbound converter answers honestly.

import { requirePrincipal } from '@/lib/auth'
import { heldFundsRunRequisition } from '@/lib/reads/billing'
import { runRequisitionDocumentHtml } from '@/lib/ops/outbound/presentation'
import { gotenbergConfigFromEnv, gotenbergHtmlToPdf } from '@/lib/bindings'
import { OperationRefused } from '@/lib/db'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const p = await requirePrincipal()
  const { id } = await params
  try {
    const data = await heldFundsRunRequisition(p, Number(id))
    const cfg = gotenbergConfigFromEnv()
    if (!cfg) {
      return new Response(
        'converter_not_configured: this deployment has no PDF converter bound',
        { status: 503 },
      )
    }
    const pdf = await gotenbergHtmlToPdf(cfg)(runRequisitionDocumentHtml(data))
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="held-funds-run-${id}-eft-requisition.pdf"`,
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
