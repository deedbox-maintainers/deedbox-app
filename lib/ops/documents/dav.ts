// Open-in-Word over WebDAV: a compact HMAC-signed token bound to one
// (document, staff) pair lets desktop Office open the document straight
// from the app via the ms-word:ofe|u|<url> scheme — edit in Word, save,
// and the save comes back as a new version through the ordinary
// version-add discipline. The token is short-lived (4 hours) and every
// WebDAV verb re-resolves the staff member's own visibility before any
// bytes move.
//
// Deployment configuration, never firm settings (the mail-key posture):
//   DEEDBOX_DAV_SECRET — >= 32 chars; absent = the door stays shut
//   DEEDBOX_APP_ORIGIN — the absolute origin Word dials back to

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface DavPayload {
  doc: number
  uid: number
  firm: number
  exp: number
}

const TTL_SECONDS = 4 * 60 * 60

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function hmac(head: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(head).digest()
}

export function signDavToken(payload: DavPayload, secret: string): string {
  const head = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `${head}.${b64url(hmac(head, secret))}`
}

export function verifyDavToken(token: string, secret: string): DavPayload | null {
  try {
    const [head, sig] = token.split('.')
    if (!head || !sig) return null
    const expect = hmac(head, secret)
    const got = Buffer.from(sig, 'base64url')
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null
    const payload = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as DavPayload
    if (
      typeof payload?.doc !== 'number' ||
      typeof payload?.uid !== 'number' ||
      typeof payload?.firm !== 'number' ||
      typeof payload?.exp !== 'number'
    ) {
      return null
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export function davSecret(): string | null {
  const s = process.env.DEEDBOX_DAV_SECRET
  return s && s.length >= 32 ? s : null
}

const OFFICE_PREFIXES: [RegExp, string, string][] = [
  [/\.(docx?|dotx)$/i, 'ms-word:ofe|u|', 'Word'],
  [/\.(xlsx?)$/i, 'ms-excel:ofe|u|', 'Excel'],
  [/\.(pptx?)$/i, 'ms-powerpoint:ofe|u|', 'PowerPoint'],
]

/**
 * The render-time link: null when the file is not an Office document, the
 * secret or origin is unset, or the token could not be minted. The 4-hour
 * life comfortably outlives a page view (minting at render keeps the
 * screen free of client script).
 */
export function officeOpenLink(input: {
  document: number
  filename: string
  staff: number
  firm: number
}): { href: string; app: string } | null {
  const secret = davSecret()
  const origin = process.env.DEEDBOX_APP_ORIGIN
  if (!secret || !origin) return null
  const match = OFFICE_PREFIXES.find(([re]) => re.test(input.filename))
  if (!match) return null
  const token = signDavToken(
    {
      doc: input.document,
      uid: input.staff,
      firm: input.firm,
      exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    },
    secret,
  )
  const safeName = encodeURIComponent(input.filename.replace(/[^\w.\-() ]+/g, '_'))
  return {
    href: `${match[1]}${origin.replace(/\/$/, '')}/api/dav/${token}/${safeName}`,
    app: match[2],
  }
}
