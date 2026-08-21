// The templates door's HTTP outcome mapping — one home for both halves.

import { NextResponse } from 'next/server'
import { unauthenticated } from '../shared'

export function templatesOutcomeResponse(
  outcome: 'unauthenticated' | 'revoked' | 'not_enabled' | 'rate_limited' | 'not_found',
  extra?: { retryAfterSeconds?: number },
): NextResponse {
  switch (outcome) {
    case 'unauthenticated':
      return unauthenticated()
    case 'revoked':
      return NextResponse.json(
        { error: 'key_revoked', message: 'this key has been revoked by the firm' },
        { status: 401 },
      )
    case 'not_enabled':
      return NextResponse.json(
        {
          error: 'templates_read_not_enabled',
          message:
            'template reading is not switched on for this key — a firm administrator can enable it on the key, under Settings, then Integration keys',
        },
        { status: 403 },
      )
    case 'rate_limited':
      return NextResponse.json(
        { error: 'rate_limited', message: 'too many requests for this key; retry shortly' },
        {
          status: 429,
          headers: { 'Retry-After': String(extra?.retryAfterSeconds ?? 60) },
        },
      )
    case 'not_found':
      return NextResponse.json(
        { error: 'template_not_found', message: 'no active template carries this id' },
        { status: 404 },
      )
  }
}
