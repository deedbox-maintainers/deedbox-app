// The bank-file download for a held-funds application run: renders the
// direct-entry (ABA) file over the run's COMPLETED transfers and hands it
// to the browser as a download. Read-only; every rule lives in the
// operation, whose typed refusals surface here as plain text.

import { requirePrincipal } from '@/lib/auth'
import { heldFundsRunAba } from '@/lib/ops/billing'
import { OperationRefused } from '@/lib/db'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const p = await requirePrincipal()
  const { id } = await params
  try {
    const f = await heldFundsRunAba(p, { run: Number(id) })
    return new Response(f.content, {
      headers: {
        'Content-Type': 'text/plain; charset=ascii',
        'Content-Disposition': `attachment; filename="${f.filename}"`,
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
