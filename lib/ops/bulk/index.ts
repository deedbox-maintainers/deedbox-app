// The operations/experience domain's bulk machinery: dry-run, commit,
// reverse, and the "my runs" panel read. The shipped kinds are the matters
// multi-select set; merge, date proposals, slot re-resolution and import
// reversal ride the same bulk-run record layer through their own domains.

export { dryRunBulk, commitBulk, reverseBulk, listReversibleRuns } from './runs'
export type { BulkMatterKind, BulkDryRun, BulkDryRunItem } from './runs'
