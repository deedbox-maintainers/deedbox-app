// GET /api/intake/v1/templates/{id} — the opt-in read door's fetch half:
// one active template's file, base64-in-JSON, with filename, content type
// and the declared merge grammar. Requires a key whose template-reading
// switch is on.

import { NextResponse } from 'next/server'
import { theFirm } from '@/lib/db'
import { templatesFetch } from '@/lib/ops/interface'
import { secretOf, unauthenticated } from '../../shared'
import { templatesOutcomeResponse } from '../shared'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const secret = secretOf(request)
  if (secret === null) return unauthenticated()
  const { id } = await params
  const templateId = Number(id)
  if (!Number.isInteger(templateId) || templateId <= 0) {
    return NextResponse.json(
      { error: 'template_not_found', message: 'no active template carries this id' },
      { status: 404 },
    )
  }
  const firm = await theFirm()
  const r = await templatesFetch(firm, secret, templateId)
  if (r.outcome !== 'ok') {
    return templatesOutcomeResponse(
      r.outcome,
      r.outcome === 'rate_limited' ? { retryAfterSeconds: r.retryAfterSeconds } : undefined,
    )
  }
  return NextResponse.json(r.result)
}
