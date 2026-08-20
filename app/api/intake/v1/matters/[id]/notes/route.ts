// POST /api/intake/v1/matters/{id}/notes — the granular notes door, same
// field shapes as the bundle. Optional external_ref gives it idempotency.

import { NextResponse } from 'next/server'
import { theFirm } from '@/lib/db'
import { intakeAddNotes } from '@/lib/ops/interface'
import { secretOf, unauthenticated, readJsonBody, outcomeResponse } from '../../../shared'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const secret = secretOf(request)
  if (secret === null) return unauthenticated()
  const { id } = await context.params
  const matter = Number(id)
  if (!Number.isInteger(matter) || matter <= 0) {
    return NextResponse.json(
      { error: 'matter_not_found', message: 'no matter by that id' },
      { status: 404 },
    )
  }
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const firm = await theFirm()
  return outcomeResponse(await intakeAddNotes(firm, secret, matter, body.body))
}
