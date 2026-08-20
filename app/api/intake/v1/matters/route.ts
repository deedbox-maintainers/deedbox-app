// POST /api/intake/v1/matters — the bundle door: one authenticated call
// delivers client + matter (+ notes + documents) and returns {matter_id,
// matter_number} under the firm's own numbering. Idempotent on (key,
// external_ref): a re-send returns the same matter, never a duplicate.

import { NextResponse } from 'next/server'
import { theFirm } from '@/lib/db'
import { intakeMatterBundle } from '@/lib/ops/interface'
import { secretOf, unauthenticated, readJsonBody, outcomeResponse } from '../shared'

export async function POST(request: Request): Promise<NextResponse> {
  const secret = secretOf(request)
  if (secret === null) return unauthenticated()
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const firm = await theFirm()
  const outcome = await intakeMatterBundle(firm, secret, body.body)
  // a missing external_ref never wrote a row — a plain 422
  if (
    outcome.outcome === 'rejected' &&
    (outcome.acknowledgement as { error?: string }).error === 'external_ref_required'
  ) {
    return NextResponse.json(outcome.acknowledgement, { status: 422 })
  }
  return outcomeResponse(outcome)
}
