'use server'

// Import actions. The wizard's validate-only run writes nothing but its own
// report; the real run is the same pipeline told to keep its work. Reversal
// is all-or-nothing and refuses batches anyone has touched since.

import { act } from '@/lib/screens/action'
import { runImportBatch, reverseImportBatch, saveMappingTemplate, startMigration, completeMigration } from '@/lib/ops/imports'
import type { RecordDomain } from '@/lib/ops/imports'
import { parse } from '@/components/forms'

function parseRecords(raw: string): { source_ref: string; data: unknown }[] {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error('records must be a JSON array')
  return parsed as { source_ref: string; data: unknown }[]
}

export async function runBatchAction(formData: FormData): Promise<void> {
  await act('/imports', async (p) => {
    const mode = parse.str(formData, 'mode') === 'real' ? 'real' : 'validate_only'
    const r = await runImportBatch(
      p,
      {
        recordDomain: parse.str(formData, 'record_domain') as RecordDomain,
        sourceSystem: parse.str(formData, 'source_system'),
        mapping: parse.numOrNull(formData, 'mapping') ?? undefined,
        migration: parse.numOrNull(formData, 'migration') ?? undefined,
        records: parseRecords(parse.str(formData, 'records')),
      },
      { mode },
    )
    return `goto:/imports/${r.batch}?done=${encodeURIComponent(
      `Batch ${r.batch} ${r.state}${mode === 'validate_only' ? ' (validate-only: nothing was written)' : ''}.`,
    )}`
  })
}

export async function reverseBatchAction(formData: FormData): Promise<void> {
  const batch = parse.num(formData, 'batch')
  await act(`/imports/${batch}`, async (p) => {
    const r = await reverseImportBatch(p, { batch, reason: parse.str(formData, 'reason') })
    return r.state === 'reversed'
      ? 'Batch reversed — every record unwound; documents keep their numbers.'
      : `Nothing reversed — ${r.blockers.length} record(s) were touched since import (first: ${r.blockers[0]?.sourceRef ?? '—'}); the batch is ${r.state}.`
  })
}

export async function saveMappingAction(formData: FormData): Promise<void> {
  await act('/imports', async (p) => {
    const r = await saveMappingTemplate(p, {
      name: parse.str(formData, 'name'),
      sourceFormatKey: parse.str(formData, 'source_format_key'),
      recordType: parse.str(formData, 'record_type'),
      fieldMap: JSON.parse(parse.str(formData, 'field_map')) as Record<string, string>,
    })
    return `Mapping template #${r.id} saved.`
  })
}

export async function startMigrationAction(formData: FormData): Promise<void> {
  await act('/imports', async (p) => {
    const r = await startMigration(p, { sourceSystem: parse.str(formData, 'source_system') })
    return `Migration #${r.id} opened — batches can now attach to it.`
  })
}

export async function completeMigrationAction(formData: FormData): Promise<void> {
  await act('/imports', async (p) => {
    await completeMigration(p, { migration: parse.num(formData, 'migration') })
    return 'Migration completed — the permanent record and its artefact are stored.'
  })
}
