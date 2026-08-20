// The import domain's operations: mapping templates, the migration record,
// the two-mode batch engine over shared appliers, and the all-or-nothing
// batch reversal, including the money-movement import. bills/time/other
// appliers are migration-workbook content.

export { saveMappingTemplate, editMappingTemplate, startMigration, completeMigration } from './mappings'
export { runImportBatch } from './batches'
export type { ImportBatchInput, ImportBatchResult, RecordDomain } from './batches'
export { reverseImportBatch } from './reverse'
export type {
  ClientRecordData,
  MatterRecordData,
  DocumentRecordData,
  DocumentVersionData,
  NoteRecordData,
  MoneyMovement,
  FullHistoryPayload,
  OpeningBalanceRecord,
  OpeningBalancesPayload,
  RecordOutcome,
} from './pipeline'
