// The inbound interface: key issue/revoke, the structurally idempotent
// submission handler, the deferred duplicate review transition, and the
// per-key activity export.

export { issueIntegrationKey, revokeIntegrationKey } from './keys'
export type { RateLimit } from './keys'
export { handleInboundSubmission, reviewDuplicateDecision } from './submissions'
export type { SubmissionRequest, SubmissionOutcome } from './submissions'
export { exportKeyActivity } from './activity'
export {
  intakeIdentity,                                                         // intake API /me
  intakeMatterBundle,                                                     // intake API bundle door
  intakeAddNotes,                                                         // intake API granular notes
  intakeAddDocuments,                                                     // intake API granular documents
  setIntakeKeyDefaults,                                                   // 0026 defaults
  clearIntakeKeyDefaults,                                                 // 0026 defaults
  setIntakeDocumentStore,                                                 // the documents seam
  INTAKE_API_SYSTEM_ACTOR,
} from './intakeApi'
export type { IntakeOutcome, MatterBundlePayload, IntakeDocumentStore } from './intakeApi'
