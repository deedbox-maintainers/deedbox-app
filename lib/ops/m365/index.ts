// The Microsoft 365 email module (schema change 0035): per-lawyer
// connections through the Graph seam, send-from-matter with the matter
// number stamped into the subject, the inbound poll filing tagged mail,
// and matter calendar events. A later change added the shared
// filing-mailbox leg (schema change 0040): filing.ts.

export { setM365Service, m365Service } from './seam'
export type { M365Service, M365Identity, M365Tokens, InboundMessage, InboundAttachment } from './seam'
export { connectM365Account, disconnectM365Account, freshConnectionInTx } from './connections'
export { sendMatterEmail, runMailPoll } from './email'
export { createMatterCalendarEvent } from './calendar'
export { ensureFilingToken, filingConfigInTx, runFilingMailboxPoll } from './filing'
export type { FilingPollResult } from './filing'
