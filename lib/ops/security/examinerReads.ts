// Examiner-read recording for the examiner workspace's surfaces.
//
// Every surface that serves an examiner calls this BEFORE returning its
// data: one entry for the surface's account-level content, plus one entry
// per matter whose identity the surface discloses through the ledger
// header pinhole — each in its own committed transaction, deduped at the
// per-session/record/surface grain, exactly as restricted-read recording
// works for staff. If the recording fails the content is withheld: the
// caller lets the thrown error propagate instead of rendering (fail
// closed).
//
// Implementation note: the recording TRANSACTION runs as the system
// principal, because the examiner's own row policies admit only money reads
// — the dedup checks must see the register and the marker table. The
// entries still carry the examiner as actor, the grant as subject and the
// surface in detail; that is exactly the evidence an examiner read must
// leave behind. (The 0025 register policy also lets an examiner-context
// transaction write examiner.read itself — the pack export uses that — but
// the shared recorder needs the wider dedup reads.)

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'

/** The examiner workspace's gate: these surfaces serve examiners alone. */
export function requireExaminer(p: Principal): void {
  if (p.kind !== 'examiner') {
    throw new OperationRefused('examiner_only', 'this surface belongs to the examiner workspace')
  }
}

/**
 * Record what an examiner surface is ABOUT to disclose. `matterIds` are the
 * matters whose identity the surface renders via the ledger header (pass
 * none for account-level surfaces). Returns after the entries commit.
 */
export async function recordExaminerReads(
  p: Principal,
  surface: string,
  matterIds: Array<number | null | undefined> = [],
): Promise<void> {
  requireExaminer(p)
  const matters = [...new Set(matterIds.filter((m): m is number => typeof m === 'number'))]
  const system: Principal = { kind: 'system_job', id: 0, firm: p.firm }
  await withPrincipal(system, async (tx) => {
    // the surface-level entry: once per session and surface; without a
    // terminal session (direct operation tests) it is written every time —
    // the same honest posture restricted-read recording takes
    let writeSurfaceEntry = true
    if (p.session !== undefined) {
      const seen = await tx.query(
        `select 1 from deedbox.register_entry
          where event_kind = 'examiner.read' and session_ref = $1
            and matter is null and detail->>'surface' = $2`,
        [p.session, surface],
      )
      writeSurfaceEntry = seen.rowCount === 0
    }
    if (writeSurfaceEntry) {
      await emitRegister(tx, p, {
        kind: 'examiner.read',
        subjectType: 'examiner_grant',
        subject: p.id,
        detail: { surface },
      })
    }
    for (const matter of matters) {
      if (p.session !== undefined) {
        const seen = await tx.query(
          `select 1 from deedbox.restricted_read_marker
            where session_ref = $1 and matter = $2 and surface = $3`,
          [p.session, matter, surface],
        )
        if (seen.rowCount! > 0) continue
        await tx.query(
          `insert into deedbox.restricted_read_marker (session_ref, matter, surface)
           values ($1, $2, $3)`,
          [p.session, matter, surface],
        )
      }
      await emitRegister(tx, p, {
        kind: 'examiner.read',
        subjectType: 'examiner_grant',
        subject: p.id,
        matter,
        detail: { surface },
      })
    }
  })
}
