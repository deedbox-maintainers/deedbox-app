// The Microsoft 365 consent callback: the signed-in staff member
// returns from the tenant's consent screen with a code; the seam
// exchanges it and the connection row lands under their own identity.

import { redirect } from 'next/navigation'
import { OperationRefused } from '@/lib/db'
import { requirePrincipal } from '@/lib/auth'
import { connectM365Account } from '@/lib/ops/m365'

export async function GET(req: Request): Promise<Response> {
  const p = await requirePrincipal()
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  if (!code) {
    redirect(`/account?refused=${encodeURIComponent('Microsoft returned no code — connection not made')}`)
  }
  try {
    await connectM365Account(p, { code })
  } catch (e) {
    const msg = e instanceof OperationRefused ? e.message : 'the connection could not be made'
    redirect(`/account?refused=${encodeURIComponent(msg)}`)
  }
  redirect(`/account?done=${encodeURIComponent('Microsoft 365 connected — tagged inbox mail now files itself')}`)
}
