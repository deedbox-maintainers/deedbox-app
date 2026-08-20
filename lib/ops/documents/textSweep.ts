// The text-extraction sweep (job id 21): versions with no text row — intake
// arrivals, imports, anything born before extraction existed — get their
// bytes fetched back through the seam, extracted, and written exactly once
// (the text row's uniqueness is the idempotency). A run is capped by COUNT
// and by TIME so one enormous backlog never starves the scheduler and the
// run always answers inside the scheduler's own patience; the next run
// continues where this one left off.
//
// Shape note: the list is read in one read-only transaction, but each
// item's write commits in its OWN transaction — extraction (byte fetch +
// parsing, seconds per document) holds no database transaction open, so a
// run never pins a pooled connection for its whole life and a mid-run stop
// loses nothing (the previous whole-run transaction outlived the
// scheduler's 55 s wait every cycle and died mid-batch).

import type { Principal } from '@/lib/db'
import { withPrincipal } from '@/lib/db'
import { requireByteFetch } from './store'
import { extractText, extractableFormat } from './extract'
import { writeVersionTextInTx } from './documents'

const SWEEP_CAP = 25
const TIME_BUDGET_MS = 35_000

// Bytes are fetched whole, so an oversized object kills the instance from
// OUTSIDE the try/catch and the sweep re-fetches it forever (a 1 GB
// body-cam video at the head of one installation's backfill queue once
// OOM-killed every run for 12 hours). The catalogue row carries filename,
// type and
// size, so extractability is decided BEFORE the fetch: unreadable formats
// and over-cap files are recorded text-less without costing a byte. The
// cap clears the largest embedded-text extraction ever seen (52 MB) with
// room, and sits far below the observed kill zone.
const FETCH_CAP_BYTES = 64 * 1024 * 1024

export async function runDocumentTextSweep(
  p: Principal,
): Promise<{ extracted: number; failed: number; skipped: number }> {
  const fetcher = requireByteFetch()
  const startedAt = Date.now()
  const pending = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select v.id as version_id, v.document, df.filename, df.content_type, df.size_bytes, df.storage_ref
           from deedbox.document_version v
           join deedbox.document_file df on df.id = v.file
           join deedbox.document d on d.id = v.document
          where not exists (select 1 from deedbox.document_version_text t where t.version = v.id)
          order by v.id
          limit ${SWEEP_CAP}`,
      )
      return r.rows
    },
    { readOnly: true },
  )
  let extracted = 0
  let failed = 0
  let skipped = 0
  for (const row of pending) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break // the next run continues
    const fetchable =
      extractableFormat(row.filename as string, row.content_type as string) &&
      Number(row.size_bytes) <= FETCH_CAP_BYTES
    let text: { content: string; method: 'embedded' | 'none' | 'ocr' } | null = null
    if (fetchable) {
      try {
        const fetched = await fetcher(row.storage_ref as string)
        text = await extractText(fetched.bytes, row.filename as string, row.content_type as string)
      } catch {
        // an unfetchable object is honestly recorded as text-less so the
        // sweep never spins on it forever
        text = null
      }
    }
    await withPrincipal(p, async (tx) => {
      await writeVersionTextInTx(
        tx,
        row.version_id as number,
        row.document as number,
        text ?? { content: '', method: 'none' },
      )
    })
    if (!fetchable) skipped++
    else if (text !== null) extracted++
    else failed++
  }
  return { extracted, failed, skipped }
}
