// The Microsoft 365 seam: the Graph connection is a service the
// deployment binds — exactly the email-transport/sign-in/document-store
// posture. Unbound, every Microsoft-touching operation refuses typed.

import { OperationRefused } from '@/lib/db'
import { seamSlot } from '@/lib/seam-slot'

export interface M365Identity {
  msUserId: string
  email: string
  displayName?: string
  scopes?: string
  accessToken: string
  refreshToken: string
  expiresAt: string
}

export interface M365Tokens {
  accessToken: string
  refreshToken: string
  expiresAt: string
}

export interface InboundMessage {
  msMessageId: string
  internetMessageId: string
  subject: string
  bodyPreview: string
  bodyHtml?: string
  from?: string
  to: string[]
  cc: string[]
  receivedAt: string
  hasAttachments?: boolean
}

export interface InboundAttachment {
  id: string
  name: string
  contentType: string
  sizeBytes: number
  /** Inline for small attachments; absent means fetch the raw bytes. */
  bytesBase64?: string
}

export interface M365Service {
  /** The consent URL the connect button walks to; state round-trips. */
  consentUrl(state: string): string
  /** OAuth code → the connected identity and its tokens. */
  exchangeCode(code: string): Promise<M365Identity>
  /** Refresh-token upkeep. */
  refresh(refreshToken: string): Promise<M365Tokens>
  /** Inbox messages received since the given moment. */
  listInboxSince(accessToken: string, sinceIso: string): Promise<InboundMessage[]>
  /** Send as the connected person; ids when the provider serves them. */
  sendMail(
    accessToken: string,
    input: { to: string[]; cc?: string[]; subject: string; bodyHtml: string },
  ): Promise<{ msMessageId?: string; internetMessageId?: string }>
  /** Create a calendar event as the connected person. */
  createEvent(
    accessToken: string,
    input: { subject: string; startsAt: string; endsAt?: string; location?: string },
  ): Promise<{ msEventId: string; webLink?: string }>
  /** Inbox of a SHARED mailbox the connected person holds Full Access to. */
  listMailboxInboxSince(accessToken: string, mailbox: string, sinceIso: string): Promise<InboundMessage[]>
  /** File attachments of one message in that shared mailbox. */
  listAttachments(accessToken: string, mailbox: string, msMessageId: string): Promise<InboundAttachment[]>
  /** Raw bytes of one attachment (the large-attachment path). */
  fetchAttachment(accessToken: string, mailbox: string, msMessageId: string, attachmentId: string): Promise<Buffer>
  /** Mark one message in that shared mailbox read. */
  markRead(accessToken: string, mailbox: string, msMessageId: string): Promise<void>
}

// Process-wide, not module-level: see lib/seam-slot.ts for why.
const slot = seamSlot<M365Service>('m365-service')

export function setM365Service(svc: M365Service | null): void {
  slot.set(svc)
}

export function m365Service(): M365Service {
  const bound = slot.get()
  if (!bound) {
    throw new OperationRefused('m365_unbound', 'the Microsoft 365 service is not configured on this installation')
  }
  return bound
}
