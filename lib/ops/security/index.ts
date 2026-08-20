// The security domain's operations. The hosted auth service authenticates;
// these operations resolve identity, maintain terminal sessions and devices,
// apply the auth policy, and administer staff, factors and examiner grants.
// Restriction discipline lives with the matters domain's operations over
// this domain's constraint layer; anomaly evaluation (the cursor job) and
// the chain verifier live with their own modules. Role/capability
// administration, the auth-policy save, anomaly acknowledgement and the
// generic soft-delete restore live with the screens that are their only
// consumers.

export {
  establishStaffSession,
  recordCredentialFailure,
  completeStepUp,
  recordStepUpFailure,
  assertStepUpInTx,
  resolveSessionPrincipal,
  endSession,
  endExaminerSession,
  endAllSessionsFor,
  revokeDevice,
  runSessionTimeouts,                                                   // job
} from './sessions'
export type { SignInInput, SignInOutcome } from './sessions'
export {
  createStaffMember,
  changeStaffRole,
  deactivateStaff,
  reactivateStaff,
  enrolMfaCredential,
  removeMfaCredential,
} from './staff'
export type { CreateStaffInput } from './staff'
export {
  grantExaminer,
  revokeExaminer,
  examinerSignIn,
  runExaminerExpiry,                                                    // job
  exportExaminationPack,
} from './examiners'
export {
  createRole,
  renameRole,
  setRoleActive,
  setRoleCapability,
} from './roles'
export type { SetRoleCapabilityInput } from './roles'
export { saveAuthPolicy } from './policy'                               // policy screen
export type { AuthPolicyInput } from './policy'
export { acknowledgeAnomaly } from './anomalies'                        // verb
export {
  runAnomalyEvaluation,                                                 // job
  raiseAnomalyInTx,                                                     // direct raise
  runChainVerification,                                                 // job
} from './anomalyJobs'
export { restoreSoftDeleted } from './restore'
export { computeRestrictionDelta, effectiveViewersInTx } from './restrictionDelta'
export type { VisibilityDelta } from './restrictionDelta'
export { recordRestrictedViews } from './restrictedViews'               // surfaces
export { recordExaminerReads, requireExaminer } from './examinerReads'  // examiner
