// The reporting and experience operations: the 31-key shipped catalogue's
// query builders, exports as privileged registered events carrying the
// exact artefact and the restricted-matter count, saved reports and
// per-recipient predicate-bound schedules, targets, the one sanctioned
// cache with its continuous verifier, and search/recents/pins. The command
// palette and the index rebuild are dispatchers over these;
// bulk/import/inbound operations follow in the next increment.

export { runReport, runReportInTx } from './engine'
export type { ReportFilters, ReportResult } from './engine'
export {
  exportReport,
  saveReport,
  runSavedReport,
  savedReportView,                                                      // the saved layout
  replaceTargets,
  listTargets,
} from './exports'
export {
  createReportSchedule,
  setSchedulePaused,
  runDueSchedules,                                                      // system
} from './schedules'
export {
  suggest,
  search,
  recordView,
  pinItem,
  unpinItem,
  recomputePositionCache,                                               // system
  verifyPositionCache,                                                  // system
} from './experience'
