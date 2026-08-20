// The client-money domain's operations: receipts and reversals, the payment
// ceremony, transfers with the intent authorisation, earmarks, entitlements,
// instruments, bank statement lines and the reconciliation workspace,
// incidents, dormancy, client statements, statutory registers, period close,
// the clearance display, ledger/account lifecycle, and the statutory
// set-aside (requirement, scheduled recalculation over the expression-formula
// evaluator, the confirmed paired movement). The examiner operations live
// with the security domain; import with the import domain.

export { recordMoneyReceipt, reverseMoneyTransaction, ensureLedgerInTx, emailReceipt } from './receipts'
export type { ReceiptInput } from './receipts'
export {
  draftMoneyPayment,
  submitMoneyPayment,
  authoriseMoneyPayment,
  rejectMoneyPayment,
  cancelMoneyPayment,
  executeMoneyPayment,
  resubmitBlockedPayment,
  loadExecutableDoc,
  executePaymentCoreInTx,
} from './payments'
export {
  authoriseTransferIntent,                                              // authorisation on a transfer subject
  ledgerTransfer,
  crossAccountTransfer,
  placeEarmark,
  releaseEarmark,
  establishEntitlement,
  recordEntitlementNotice,
  cancelEntitlement,
} from './transfers'
export {
  ingestBankStatementLines,
  buildReconciliation,
  createMatchGroup,
  dissolveMatchGroup,
  createReconException,
  resolveReconException,
  certifyReconciliation,
} from './recon'
export {
  materialiseCloseObligations,                                          // system job
  openPeriodClose,
  certifyPeriodClose,
} from './close'
export {
  runDormancyDetection,                                                 // system job
  recordContactAttempt,
  resolveDormantCase,
  executeRemittance,
} from './dormancy'
export {
  generateClientMoneyStatement,
  issueClientMoneyStatement,
  appendStatutoryRegisterEntry,
  promoteRefusalToIncident,
  rectifyIncident,
  reportIncident,
  matterMoneyClearance,                                                 // display only
} from './statutory'
export {
  bankInstrument,
  dishonourInstrument,
  cancelInstrument,
  linkReplacementInstrument,
  runStaleInstrumentSweep,
} from './instruments'
export {
  openLedger,
  closeLedger,
  reopenLedger,
  createClientAccount,
  deactivateClientAccount,
} from './lifecycle'
export {
  establishSetAsideRequirement,
  runSetAsideRecalculation,                                             // system job
  confirmSetAsideMovement,
} from './setAside'
