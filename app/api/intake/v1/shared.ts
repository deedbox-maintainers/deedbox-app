// The intake API's route-layer conventions: the x-api-key header carries
// the key's shown-once secret; bodies are JSON, size-capped; outcomes map
// to plain-English {error, message} bodies. Every rule lives in
// lib/ops/interface/intakeApi — these helpers only translate HTTP.

import { NextResponse } from 'next/server'
import type { IntakeOutcome } from '@/lib/ops/interface'

/** The documented request-body cap (inline base64 documents included). */
export const BODY_CAP_BYTES = 10 * 1024 * 1024

export function secretOf(request: Request): string | null {
  const v = request.headers.get('x-api-key')
  return v && v.trim() ? v.trim() : null
}

export function unauthenticated(): NextResponse {
  return NextResponse.json(
    { error: 'unauthenticated', message: 'a valid x-api-key header is required' },
    { status: 401 },
  )
}

export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > BODY_CAP_BYTES) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'payload_too_large', message: 'the request body exceeds the 10 MB cap' },
        { status: 413 },
      ),
    }
  }
  const text = await request.text()
  if (Buffer.byteLength(text) > BODY_CAP_BYTES) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'payload_too_large', message: 'the request body exceeds the 10 MB cap' },
        { status: 413 },
      ),
    }
  }
  try {
    return { ok: true, body: text === '' ? {} : JSON.parse(text) }
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'invalid_json', message: 'the request body is not valid JSON' },
        { status: 422 },
      ),
    }
  }
}

/** Rejection slugs that are the caller's shape problem (422) vs addressing (404). */
const NOT_FOUND_SLUGS = new Set(['matter_not_found'])

export function outcomeResponse(o: IntakeOutcome): NextResponse {
  switch (o.outcome) {
    case 'unauthenticated':
      return unauthenticated()
    case 'revoked':
      return NextResponse.json(
        { error: 'key_revoked', message: 'this key has been revoked by the firm' },
        { status: 401 },
      )
    case 'rate_limited':
      return NextResponse.json(
        { error: 'rate_limited', message: 'too many requests for this key; retry shortly' },
        { status: 429, headers: { 'Retry-After': String(o.retryAfterSeconds) } },
      )
    case 'created':
      return NextResponse.json(o.acknowledgement, { status: 201 })
    case 'duplicate_replayed':
      // A re-send returns the same record, never a duplicate
      return NextResponse.json(o.acknowledgement, { status: 200 })
    case 'rejected': {
      const slug = (o.acknowledgement as { error?: string } | null)?.error ?? 'rejected'
      const status = NOT_FOUND_SLUGS.has(slug) ? 404 : 422
      return NextResponse.json(o.acknowledgement, { status })
    }
  }
}
