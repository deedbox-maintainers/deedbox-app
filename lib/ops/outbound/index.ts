// Outbound and artefact operations: the queue writer (in-transaction seam +
// standalone), the dispatch job over the delivery seam, the generic manual
// retry, and gated artefact retrieval.

export {
  queueOutboundMessage,
  queueOutboundMessageInTx,
  dispatchOutboundQueue,
  retryOutboundMessage,
  retrieveArtefact,
} from './messages'
export type { QueueMessageInput, Deliverer } from './messages'
export { presenterFor, billDocumentHtml, requisitionDocumentHtml, ledgerDocumentHtml } from './presentation'
export type {
  PresentedMessage,
  PresentedAttachment,
  PresentContext,
  HtmlToPdf,
} from './presentation'
