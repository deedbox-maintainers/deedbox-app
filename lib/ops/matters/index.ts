// The matters/parties domain's operations, one exported function per
// operation. The text-registration interface is not exposed here;
// it arrives with its consumers.

export { checkDuplicates } from './duplicates'
export { dryRunMerge, commitMerge, undoMerge } from './merge'
export type { MergeDryRun } from './merge'
export { runConflictCheck } from './runConflictCheck'
export type { ConflictTerms, ConflictRunResult } from './runConflictCheck'
export type { DuplicateCandidate } from './duplicates'
export { createParty } from './createParty'
export type { CreatePartyInput, ContactInput, AddressInput } from './createParty'
export { renameParty, addPartyName } from './partyNames'
export { addContactPoint, softDeleteContactPoint, addAddress } from './partyContacts'
export { linkParties } from './linkParties'
export { createMatter } from './createMatter'
export { updateMatterDetails } from './updateDetails'
export type { CreateMatterInput } from './createMatter'
export {
  closeMatter,
  approveCloseRequest,
  rejectCloseRequest,
  withdrawCloseRequest,
  reopenMatter,
  archiveMatter,
  holdMatter,
  resumeMatter,
} from './matterLifecycle'
export type { FinancialPosition } from './matterLifecycle'
export {
  addMatterParty,
  setPortalAccess,
  softDeleteMatterParty,
  changeClient,
} from './matterParties'
export { relateMatters, unrelateMatters, createRelatedMatter } from './relations'
export type { CreateRelatedMatterInput } from './relations'
export { attachConflictCheck, recordConflictResolution } from './conflictRecords'
export { changeRestriction, readMembership } from './restriction'
export type { RestrictionChange, Membership } from './restriction'
export { changeStaffing } from './staffing'
export { createNote, editNote, softDeleteNote, restoreNote } from './notes'
export {
  createIntake,
  moveIntakeStage,
  setIntakeOutcome,
  closeIntake,
  reopenIntake,
  addIntakeParty,
  softDeleteIntakeParty,
  convertIntake,
} from './intake'
export type { CreateIntakeInput, ConvertIntakeInput } from './intake'
export {
  createPracticeArea,
  renamePracticeArea,
  setPracticeAreaActive,
  setConflictRequirement,
  setRelatablePair,
} from './practiceAreas'
export {
  createIntakeStage,                                                    // admin
  renameIntakeStage,
  setIntakeStageActive,
  reorderIntakeStages,
} from './intakeStages'
export { closePositionInTx } from './matterLifecycle'                   // close screen
