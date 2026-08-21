// GET /api/intake/v1/templates — the opt-in read door's list half: the
// firm's ACTIVE document templates with their metadata and declared merge
// grammar. Requires a key whose template-reading switch is on.

import { NextResponse } from 'next/server'
import { theFirm } from '@/lib/db'
import { templatesList } from '@/lib/ops/interface'
import { secretOf, unauthenticated } from '../shared'
import { templatesOutcomeResponse } from './shared'

export async function GET(request: Request): Promise<NextResponse> {
  const secret = secretOf(request)
  if (secret === null) return unauthenticated()
  const firm = await theFirm()
  const r = await templatesList(firm, secret)
  if (r.outcome !== 'ok') {
    return templatesOutcomeResponse(
      r.outcome,
      r.outcome === 'rate_limited' ? { retryAfterSeconds: r.retryAfterSeconds } : undefined,
    )
  }
  return NextResponse.json(r.result)
}
