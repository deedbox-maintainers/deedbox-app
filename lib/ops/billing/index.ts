// The billing domain's operations — the complete set, including the payment
// details and send ceremony. The scheduled runners for the system bodies
// (threshold evaluation, reminder scheduler, arrangement jobs, interest
// accrual, remainder routing) arrive with the jobs slice; each body is
// exported and proven here.

export { addStaffRate, addStaffCostRate, addMatterRateOverride } from './rates'
export {
  createTimeEntry,
  editTimeEntry,
  writeOffUnbilledItem,
  softDeleteUnbilledItem,
  restoreUnbilledItem,
} from './timeEntries'
export type { CreateTimeEntryInput } from './timeEntries'
export { startTimer, pauseTimer, resumeTimer, stopTimer, discardTimer } from './timers'
export {
  ingestSignal,
  assignSuggestionMatter,
  acceptSuggestion,
  mergeSuggestion,
  discardSuggestion,
} from './suggestions'
export type { SignalInput } from './suggestions'
export {
  createDisbursement,
  editDisbursement,
  createCostType,
  deactivateCostType,
} from './disbursements'
export { reviseEstimate, setBudget, setFundsPolicy } from './estimates'
export { replacePayerSet } from './payers'
export { evaluateThresholds } from './thresholds'
export type { ThresholdEvaluation } from './thresholds'
export {
  createDraftBillGroup,
  removeDraftLine,
  writeDownDraftItem,
  addManualDraftLine,
  abandonDraftGroup,
  submitForApproval,
  sendBackToDraft,
} from './drafting'
export type { CreateDraftInput } from './drafting'
export { issueBillGroup } from './issue'
export type { IssueInput } from './issue'
export {
  createBillingRun,
  issueBillingRun,
  abandonBillingRun,
} from './runs'
export type { RunFilters } from './runs'
export {
  generateStatement,
  allocateStatementPayment,
} from './statements'
export {
  saveInterestPolicy,
  previewInterestCharge,
  addInterestCharge,
  generateInterestProposals,                                            // system
  approveInterestProposal,
  dismissInterestProposal,
} from './interest'
export {
  startChannelPayment,
  failChannelPayment,
  settleChannelPayment,
} from './channel'
export type { SettlementResult } from './channel'
export {
  createReminderSequence,
  runReminderScheduler,                                                 // system
  holdReminder,
  releaseReminder,
  assignReminderSequence,
} from './reminders'
export {
  createArrangement,
  reactivateArrangement,
  cancelArrangement,
  runInstalmentNotifications,                                           // system
  runInstalmentCollections,                                             // system
  runMissedInstalmentDetection,                                         // system
} from './arrangements'
export {
  evaluateFundsPolicy,
  confirmTopUpRequest,
  cancelTopUpRequest,
} from './topups'
export {
  previewHeldFundsApplication,
  commitHeldFundsApplication,
  authoriseHeldFundsItem,
  abandonHeldFundsRun,
} from './heldFunds'
export { applyHeldFundsToRunBills, applyHeldFundsToBills, prepareFirmWideHeldFunds } from './runHeldFunds'
export { executeHeldFundsPayment, completeExecutedHeldFundsItem } from './heldFunds'
export {
  replaceBillAttribution,
  exportBillLines,
} from './attributionExport'
export { routeUnallocatedRemainders } from './remainder'                // system
export {
  savePaymentDetails,
  approvePaymentDetails,
  previewBillSend,
  sendBill,
} from './paymentDetails'
export { heldFundsRunAba } from './aba'
export {
  recordPayment,
  allocatePayment,
  unallocatePayment,
  correctPayment,
} from './payments'
export {
  createCreditNote,
  applyCredit,
  writeOffBill,
  raiseDispute,
  resolveDispute,
  placeBillingHold,
  releaseBillingHold,
} from './postIssue'
