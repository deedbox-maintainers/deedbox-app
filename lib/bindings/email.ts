// The outbound delivery binding: a real email sender behind the jobs
// registry's transport seam. Mail is delivered through an HTTP mail API
// (Resend-shaped: one POST per message with a bearer key); this module
// reproduces exactly that, nothing more — the queue, the stored rendered
// copy, retry-is-a-new-row and the dispatch job were all built and proven
// earlier.
//
// Honesty rules, because the queue carries three kinds of content:
// - text renderings (content_type text/*) are finished messages — sent as-is;
// - bare named references (no stored artefact: the reference IS the
//   information, e.g. a top-up alert) — sent inside a short honest wrapper
//   telling the recipient what to look at;
// - - data renderings (application/json) go through the PRESENTATION step
//   (lib/ops/outbound/presentation.ts): a presenter turns the frozen data
//   into a finished message — subject, body, attachments (the bill document
//   rides the HTML→PDF converter seam, and a message that promises a document
//   is NEVER sent without it: converter trouble fails the row typed and
//   retry-is-a-new-row takes it from there). A JSON purpose with NO presenter
//   still fails typed ('presentation_pending') — a client never receives a
//   raw data document.
// - text_message rows fail typed: no text-message transport exists on this
//   installation yet.

import type { Deliverer } from '@/lib/ops/outbound'
import { presenterFor, type HtmlToPdf } from '@/lib/ops/outbound/presentation'

/** Injectable HTTP POST so the suite proves composition without a network. */
export type HttpPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; text: string }>

const realPost: HttpPost = async (url, headers, body) => {
  const r = await fetch(url, { method: 'POST', headers, body })
  return { status: r.status, text: await r.text().catch(() => '') }
}

export interface EmailTransportConfig {
  apiKey: string
  /** The sender, exactly as mail should carry it: `Name <address>`. */
  from: string
  endpoint?: string
  post?: HttpPost
  /** The HTML→PDF converter; absent = document-promising purposes fail typed. */
  htmlToPdf?: HtmlToPdf
}

/** Human subject lines for the purposes the product queues today. */
const SUBJECTS: Record<string, string> = {
  anomaly_alert: 'Security alert',
  unrecognised_sign_in: 'Sign-in verification required',
  scheduled_report: 'Your scheduled report',
  schedule_paused: 'A scheduled report was paused',
  top_up_alert: 'A matter needs funds topped up',
  general_notice: 'Notice',
}

function subjectFor(purpose: string): string {
  return SUBJECTS[purpose] ?? purpose.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

export function emailTransport(cfg: EmailTransportConfig): Deliverer {
  const endpoint = cfg.endpoint ?? 'https://api.resend.com/emails'
  const post = cfg.post ?? realPost
  return async (message) => {
    if (message.channel !== 'email') {
      throw new Error(
        `channel_unsupported: no ${message.channel} transport is bound on this installation`,
      )
    }
    let payload: Record<string, unknown>
    if (message.contentType !== null && message.contentType.startsWith('application/json')) {
      const presenter = presenterFor(message.purpose)
      if (!presenter) {
        throw new Error(
          `presentation_pending: the stored rendering for '${message.purpose}' is a data document, not a finished message`,
        )
      }
      let data: unknown
      try {
        data = JSON.parse(message.content)
      } catch {
        throw new Error(`presentation_failed: the stored rendering for '${message.purpose}' is not readable data`)
      }
      const presented = await presenter(data, { htmlToPdf: cfg.htmlToPdf })
      payload = {
        from: cfg.from,
        to: [message.recipient],
        subject: presented.subject,
        ...(presented.text !== undefined ? { text: presented.text } : {}),
        ...(presented.html !== undefined ? { html: presented.html } : {}),
        ...(presented.attachments && presented.attachments.length > 0
          ? {
              attachments: presented.attachments.map((a) => ({
                filename: a.filename,
                content: a.contentBase64,
              })),
            }
          : {}),
      }
    } else {
      const body =
        message.contentType === null
          ? `${subjectFor(message.purpose)}.\n\nReference: ${message.content}\n\nSign in to view it.`
          : message.content
      payload = {
        from: cfg.from,
        to: [message.recipient],
        subject: subjectFor(message.purpose),
        text: body,
      }
    }
    const r = await post(
      endpoint,
      {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify(payload),
    )
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`mail_api_error: HTTP ${r.status} ${r.text.slice(0, 160)}`)
    }
  }
}
