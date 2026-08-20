// GET /api/intake/v1/me — the identity check: proves a key works and labels
// the connection with the firm's display name, nothing else.

import { NextResponse } from 'next/server'
import { theFirm } from '@/lib/db'
import { intakeIdentity } from '@/lib/ops/interface'
import { secretOf, unauthenticated } from '../shared'

export async function GET(request: Request): Promise<NextResponse> {
  const secret = secretOf(request)
  if (secret === null) return unauthenticated()
  const firm = await theFirm()
  const r = await intakeIdentity(firm, secret)
  if (!r.ok) {
    return r.reason === 'revoked'
      ? NextResponse.json(
          { error: 'key_revoked', message: 'this key has been revoked by the firm' },
          { status: 401 },
        )
      : unauthenticated()
  }
  return NextResponse.json({ ok: true, firm_name: r.firmName })
}
