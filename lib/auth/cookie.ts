// The session cookie carrier. The architecture keeps AUTHENTICATION with
// the hosted platform's service; until that service is bound, the carrier
// between browser and server is this HMAC-signed cookie: the value names
// the terminal session row and carries a signature under
// DEEDBOX_COOKIE_SECRET, so a session id can never be forged by guessing
// (ids are sequential). The cookie proves nothing about the PERSON — every
// request still resolves the session row and re-evaluates the windows, the
// step-up gate and the staff active flag (no cached authority).

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'deedbox_session'
export const DEVICE_COOKIE = 'deedbox_device'

function secret(): string | null {
  return process.env.DEEDBOX_COOKIE_SECRET ?? null
}

export function cookiesConfigured(): boolean {
  return secret() !== null
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('hex')
}

/** session id → signed cookie value; null when the secret is unset. */
export function sealSession(sessionId: number): string | null {
  const key = secret()
  if (key === null) return null
  const payload = String(sessionId)
  return `${payload}.${sign(payload, key)}`
}

/** signed cookie value → session id; null on any mismatch. */
export function openSession(value: string | undefined | null): number | null {
  const key = secret()
  if (key === null || !value) return null
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = value.slice(0, dot)
  const mac = value.slice(dot + 1)
  const expected = sign(payload, key)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const id = Number(payload)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
