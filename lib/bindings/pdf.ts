// The HTML→PDF converter binding: a self-hosted Gotenberg/Chromium service,
// spoken to over one multipart POST with basic auth, and a %PDF sanity
// check so a broken converter can never masquerade as a document.
// Deployment environment, never firm settings: DEEDBOX_GOTENBERG_URL /
// DEEDBOX_GOTENBERG_USER / DEEDBOX_GOTENBERG_PASS

import type { HtmlToPdf } from '@/lib/ops/outbound/presentation'

export interface GotenbergConfig {
  url: string
  user: string
  pass: string
}

export function gotenbergConfigFromEnv(): GotenbergConfig | null {
  const url = (process.env.DEEDBOX_GOTENBERG_URL ?? '').replace(/\/+$/, '')
  const user = process.env.DEEDBOX_GOTENBERG_USER ?? ''
  const pass = process.env.DEEDBOX_GOTENBERG_PASS ?? ''
  return url && user && pass ? { url, user, pass } : null
}

export function gotenbergHtmlToPdf(cfg: GotenbergConfig): HtmlToPdf {
  return async (html: string): Promise<Buffer> => {
    const fd = new FormData()
    fd.append('files', new Blob([html], { type: 'text/html' }), 'index.html')
    fd.append('preferCssPageSize', 'true')
    fd.append('printBackground', 'true')
    const r = await fetch(`${cfg.url}/forms/chromium/convert/html`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64'),
      },
      body: fd,
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new Error(`converter_error: HTTP ${r.status} ${t.slice(0, 160)}`)
    }
    const bytes = Buffer.from(await r.arrayBuffer())
    if (bytes.length < 5 || bytes.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error('converter_error: the converter did not return a PDF')
    }
    return bytes
  }
}
