// The documents module's operations (schema change 0030): folders,
// upload/versions over the byte-store seam, filing intake arrivals,
// metadata, checkout/checkin, lock, legal hold, soft delete and restore,
// access evidence. Sharing, signing, templates, OCR/full-text and email
// live in their own modules.

export { setDocumentByteStore, setDocumentByteFetch, requireByteStore, requireByteFetch } from './store'
export type { DocumentByteStore, DocumentByteFetch, StoredBytes } from './store'
export {
  uploadDocumentTemplate,
  editDocumentTemplate,
  softDeleteDocumentTemplate,
  generateFromTemplate,
} from './templates'
export {
  createDocumentShare,
  revokeDocumentShare,
  resolveShareForServe,
  peekShare,
  SHARE_SIGN_DOOR_ACTOR,
} from './sharing'
export {
  createSigningRequest,
  revokeSigningRequest,
  peekSigningRequest,
  completeSigning,
} from './signing'
export { extractText } from './extract'
export { runDocumentTextSweep } from './textSweep'
export { syncDocumentText, writeVersionTextInTx, recordOcrText } from './documents'
export { createFolder, renameFolder, moveFolder, deleteEmptyFolder } from './folders'
export {
  uploadDocument,
  addDocumentVersion,
  fileArrival,
  editDocument,
  checkoutDocument,
  checkinDocument,
  setDocumentLock,
  setLegalHold,
  softDeleteDocument,
  restoreDocument,
  recordDocumentAccess,
} from './documents'
