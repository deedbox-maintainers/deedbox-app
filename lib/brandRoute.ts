// Serving the installation's brand files. A firm's uploaded logo and icon
// live in the installation's own object storage; the browser needs them on
// the sign-in page BEFORE anyone is signed in, so these routes are public —
// they serve only the two objects the branding slot names, never anything a
// caller could choose. When nothing is uploaded they redirect to the built-in
// artwork the CDN serves from /public. Both are cacheable: the href carries a
// tag that changes when the stored reference changes.

import { readBrand, DEFAULT_LOGO_HREF, DEFAULT_ICON_HREF } from '@/lib/brand'
import { requireByteFetch } from '@/lib/ops/documents/store'

const IMAGE_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
}

function typeFor(ref: string, fallback: string): string {
  const ext = ref.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_TYPES[ext] ?? fallback
}

/** The built-in artwork is a static file the CDN serves; the route just points at it. */
function defaultRedirect(kind: 'logo' | 'icon', requestUrl: string): Response {
  const href = kind === 'logo' ? DEFAULT_LOGO_HREF : DEFAULT_ICON_HREF
  return Response.redirect(new URL(href, requestUrl), 302)
}

/** GET /brand/logo or /brand/icon — the stored file, else the built-in default. */
export async function serveBrandFile(kind: 'logo' | 'icon', requestUrl: string): Promise<Response> {
  const brand = await readBrand()
  const ref = kind === 'logo' ? brand.logoRef : brand.iconRef
  if (!ref) return defaultRedirect(kind, requestUrl)
  try {
    const { bytes, contentType } = await requireByteFetch()(ref)
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': typeFor(ref, contentType),
        'Cache-Control': 'public, max-age=300',
        // a logo is a picture: never let a browser treat it as a page
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    // storage unbound or the object gone: the installation still has a face
    return defaultRedirect(kind, requestUrl)
  }
}
