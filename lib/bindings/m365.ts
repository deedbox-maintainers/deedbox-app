// The hosted Microsoft 365 binding: the real Graph protocol behind the
// M365Service seam — OAuth code exchange and refresh against the
// tenant's token endpoint, inbox listing, send-as-the-person, and
// calendar event creation. Configuration is deployment environment (like
// the mail key), never firm settings.

import type { M365Service, InboundMessage, InboundAttachment } from '@/lib/ops/m365/seam'

export interface M365Config {
  clientId: string
  clientSecret: string
  tenantId: string
  redirectUri: string
}

// Mail.ReadWrite.Shared serves the shared filing mailbox (read + mark-read
// as the delegated reader); connections consented before it was added need
// one re-consent before the filing leg sees the mailbox.
const SCOPES = 'offline_access User.Read Mail.Read Mail.Send Mail.ReadWrite.Shared Calendars.ReadWrite'

async function graph<T>(accessToken: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(`m365_graph_error: ${method} ${path} -> HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const text = await r.text()
  return (text ? JSON.parse(text) : {}) as T
}

export function hostedM365Service(cfg: M365Config): M365Service {
  const tokenUrl = `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`

  async function tokenRequest(form: URLSearchParams): Promise<{
    access_token: string
    refresh_token?: string
    expires_in: number
  }> {
    form.set('client_id', cfg.clientId)
    form.set('client_secret', cfg.clientSecret)
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    if (!r.ok) throw new Error(`m365_token_error: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
    return (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number }
  }

  return {
    consentUrl(state) {
      const q = new URLSearchParams({
        client_id: cfg.clientId,
        response_type: 'code',
        redirect_uri: cfg.redirectUri,
        response_mode: 'query',
        scope: SCOPES,
        state,
      })
      return `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize?${q}`
    },

    async exchangeCode(code) {
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
        scope: SCOPES,
      })
      const tok = await tokenRequest(form)
      const me = await graph<{ id: string; mail?: string; userPrincipalName: string; displayName?: string }>(
        tok.access_token,
        'GET',
        '/me',
      )
      return {
        msUserId: me.id,
        email: me.mail ?? me.userPrincipalName,
        displayName: me.displayName,
        scopes: SCOPES,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? '',
        expiresAt: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      }
    },

    async refresh(refreshToken) {
      const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
      const tok = await tokenRequest(form)
      return {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? refreshToken,
        expiresAt: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      }
    },

    async listInboxSince(accessToken, sinceIso) {
      type GraphMessage = {
        id: string
        internetMessageId: string
        subject?: string
        bodyPreview?: string
        body?: { contentType: string; content: string }
        from?: { emailAddress: { address: string } }
        toRecipients?: { emailAddress: { address: string } }[]
        ccRecipients?: { emailAddress: { address: string } }[]
        receivedDateTime: string
      }
      const q = new URLSearchParams({
        $filter: `receivedDateTime ge ${sinceIso}`,
        $orderby: 'receivedDateTime asc',
        $top: '50',
        $select: 'id,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime',
      })
      const page = await graph<{ value: GraphMessage[] }>(
        accessToken,
        'GET',
        `/me/mailFolders/inbox/messages?${q}`,
      )
      return (page.value ?? []).map(
        (m): InboundMessage => ({
          msMessageId: m.id,
          internetMessageId: m.internetMessageId,
          subject: m.subject ?? '',
          bodyPreview: m.bodyPreview ?? '',
          bodyHtml: m.body?.contentType?.toLowerCase() === 'html' ? m.body.content : undefined,
          from: m.from?.emailAddress.address,
          to: (m.toRecipients ?? []).map((r) => r.emailAddress.address),
          cc: (m.ccRecipients ?? []).map((r) => r.emailAddress.address),
          receivedAt: m.receivedDateTime,
        }),
      )
    },

    async sendMail(accessToken, input) {
      await graph(accessToken, 'POST', '/me/sendMail', {
        message: {
          subject: input.subject,
          body: { contentType: 'HTML', content: input.bodyHtml },
          toRecipients: input.to.map((a) => ({ emailAddress: { address: a } })),
          ccRecipients: (input.cc ?? []).map((a) => ({ emailAddress: { address: a } })),
        },
        saveToSentItems: true,
      })
      // Graph's sendMail returns no identifiers; the sent record stands on
      // the matter row itself (dedup applies to RECEIVED mail only)
      return {}
    },

    async createEvent(accessToken, input) {
      const ev = await graph<{ id: string; webLink?: string }>(accessToken, 'POST', '/me/events', {
        subject: input.subject,
        start: { dateTime: input.startsAt, timeZone: 'UTC' },
        end: { dateTime: input.endsAt ?? input.startsAt, timeZone: 'UTC' },
        ...(input.location ? { location: { displayName: input.location } } : {}),
      })
      return { msEventId: ev.id, webLink: ev.webLink }
    },

    async listMailboxInboxSince(accessToken, mailbox, sinceIso) {
      type GraphMessage = {
        id: string
        internetMessageId: string
        subject?: string
        bodyPreview?: string
        hasAttachments?: boolean
        body?: { contentType: string; content: string }
        from?: { emailAddress: { address: string } }
        toRecipients?: { emailAddress: { address: string } }[]
        ccRecipients?: { emailAddress: { address: string } }[]
        receivedDateTime: string
      }
      const q = new URLSearchParams({
        $filter: `receivedDateTime ge ${sinceIso}`,
        $orderby: 'receivedDateTime asc',
        $top: '50',
        $select:
          'id,internetMessageId,subject,bodyPreview,hasAttachments,body,from,toRecipients,ccRecipients,receivedDateTime',
      })
      const page = await graph<{ value: GraphMessage[] }>(
        accessToken,
        'GET',
        `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?${q}`,
      )
      return (page.value ?? []).map(
        (m): InboundMessage => ({
          msMessageId: m.id,
          internetMessageId: m.internetMessageId,
          subject: m.subject ?? '',
          bodyPreview: m.bodyPreview ?? '',
          bodyHtml: m.body?.contentType?.toLowerCase() === 'html' ? m.body.content : undefined,
          from: m.from?.emailAddress.address,
          to: (m.toRecipients ?? []).map((r) => r.emailAddress.address),
          cc: (m.ccRecipients ?? []).map((r) => r.emailAddress.address),
          receivedAt: m.receivedDateTime,
          hasAttachments: m.hasAttachments ?? false,
        }),
      )
    },

    async listAttachments(accessToken, mailbox, msMessageId) {
      type GraphAttachment = {
        '@odata.type'?: string
        id: string
        name?: string
        contentType?: string
        size?: number
        contentBytes?: string
      }
      const page = await graph<{ value: GraphAttachment[] }>(
        accessToken,
        'GET',
        `/users/${encodeURIComponent(mailbox)}/messages/${msMessageId}/attachments`,
      )
      return (page.value ?? [])
        .filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment')
        .map(
          (a): InboundAttachment => ({
            id: a.id,
            name: a.name ?? 'attachment',
            contentType: a.contentType ?? 'application/octet-stream',
            sizeBytes: a.size ?? 0,
            bytesBase64: a.contentBytes,
          }),
        )
    },

    async fetchAttachment(accessToken, mailbox, msMessageId, attachmentId) {
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${msMessageId}/attachments/${attachmentId}/$value`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (!r.ok) {
        throw new Error(`m365_graph_error: attachment fetch -> HTTP ${r.status}`)
      }
      return Buffer.from(await r.arrayBuffer())
    },

    async markRead(accessToken, mailbox, msMessageId) {
      await graph(
        accessToken,
        'PATCH',
        `/users/${encodeURIComponent(mailbox)}/messages/${msMessageId}`,
        { isRead: true },
      )
    },
  }
}
